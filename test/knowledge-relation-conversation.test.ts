import { Effect, Schema } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import { NeighborhoodPage, QueryPage } from "../src/personal-knowledge/index.ts"
import type { ToolInferenceTransport } from "../src/subscription/index.ts"
import { knowledgeAnswerLayer } from "./knowledge-answer-fixture.ts"
import { answer, lastToolResult, tool } from "./knowledge-tool-frames.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { replyLayer, waitForReply } from "./reply-fixture.ts"

const ids = {
  french: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  englishPain: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  englishBread: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  episode: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  task: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  translation: "10000000-0000-4000-8000-000000000001",
  mnemonic: "10000000-0000-4000-8000-000000000002",
  association: "10000000-0000-4000-8000-000000000003",
  extra: "20000000-0000-4000-8000-000000000001",
  invalid: "20000000-0000-4000-8000-000000000002",
  missing: "ffffffff-ffff-4fff-8fff-ffffffffffff"
}
const field = (name: string) => ({ name, kind: "string", required: true })
const seed = {
  reason: "Keep distinct meanings, a personal mnemonic and a nonlexical association",
  types: [
    { name: "Expression", fields: [field("text"), field("language"), field("meaning")] },
    { name: "Episode", fields: [field("title")] },
    { name: "Task", fields: [field("title")] }
  ],
  creates: [
    { id: ids.french, type: "Expression", values: { text: "pain", language: "fr", meaning: "bread" } },
    { id: ids.englishPain, type: "Expression", values: { text: "pain", language: "en", meaning: "suffering" } },
    { id: ids.englishBread, type: "Expression", values: { text: "bread", language: "en", meaning: "bread" } },
    { id: ids.episode, type: "Episode", values: { title: "Breakfast in Paris" } },
    { id: ids.task, type: "Task", values: { title: "Buy bread" } }
  ],
  updates: [],
  relationTypes: [
    { name: "Translation", sources: ["Expression"], targets: ["Expression"], fields: [field("basis")] },
    { name: "PersonalMnemonic", sources: ["Expression"], targets: ["Episode"], fields: [field("cue")] },
    { name: "PromptsTask", sources: ["Episode"], targets: ["Task"], fields: [field("context")] }
  ],
  relationCreates: [
    {
      id: ids.translation,
      type: "Translation",
      source: ids.french,
      target: ids.englishBread,
      values: { basis: "asserted translation" }
    },
    {
      id: ids.mnemonic,
      type: "PersonalMnemonic",
      source: ids.french,
      target: ids.episode,
      values: { cue: "my breakfast" }
    },
    { id: ids.association, type: "PromptsTask", source: ids.episode, target: ids.task, values: { context: "shopping" } }
  ],
  relationUpdates: []
}
const neighborhood = { id: ids.french, depth: 2, direction: "outgoing", limit: 10 }
const run = async (transport: ToolInferenceTransport) => {
  const database = await temporaryDatabase()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          const input = {
            deliveryId: "11111111-1111-4111-8111-111111111111",
            text: "Use my saved meanings and personal associations."
          }
          yield* conversation.send(input)
          const reply = yield* waitForReply(conversation, input.deliveryId)
          expect(reply.state).toBe("Completed")
          expect(reply.text).toContain("bread")
          expect((yield* conversation.page({ limit: 100 })).messages.map((message) => message.text)).toEqual([
            input.text,
            reply.text
          ])
        })
      ).pipe(
        Effect.provide(
          replyLayer(database.path, knowledgeAnswerLayer(transport), {
            answerProvider: "subscription",
            answerModel: "gpt-6.1-sol"
          })
        )
      )
    )
  } finally {
    await database.close()
  }
}

it("uses distinct same-spelling meanings, declared translations, personal mnemonics and nonlexical two-step associations", async () => {
  let calls = 0
  await run(async (request) => {
    calls++
    if (calls === 1) return tool("apply_knowledge", seed, "seed-meanings")
    if (calls === 2) {
      expect(lastToolResult(request)).toMatchObject({
        revision: 1,
        createdRelationIds: [ids.translation, ids.mnemonic, ids.association]
      })
      return tool("query_knowledge", { type: "Expression", where: { text: "pain" }, limit: 10 }, "find-pain")
    }
    if (calls === 3) {
      const page = Schema.decodeUnknownSync(QueryPage)(lastToolResult(request))
      expect(page.entities.map((entity) => ({ id: entity.id, ...entity.values }))).toEqual([
        { id: ids.french, text: "pain", language: "fr", meaning: "bread" },
        { id: ids.englishPain, text: "pain", language: "en", meaning: "suffering" }
      ])
      return tool("query_knowledge_neighborhood", neighborhood, "use-associations")
    }
    const page = Schema.decodeUnknownSync(NeighborhoodPage)(lastToolResult(request))
    expect(page.root.id).toBe(ids.french)
    expect(page.relations).toEqual(expect.arrayContaining(seed.relationCreates))
    expect(page.entities.map((entity) => entity.id)).toContain(ids.task)
    expect(page.entities.map((entity) => entity.id)).not.toContain(ids.englishPain)
    expect(page).toMatchObject({ nextAfter: null, truncated: false })
    const translation = page.relations.find((relation) => relation.type === "Translation")
    const meaning = page.entities.find((entity) => entity.id === translation?.target)?.values["meaning"]
    const mnemonic = page.relations.find((relation) => relation.type === "PersonalMnemonic")?.values["cue"]
    const task = page.entities.find((entity) => entity.type === "Task")?.values["title"]
    return answer(
      `French pain means ${String(meaning)}. My mnemonic is ${String(mnemonic)}; the related task is ${String(task)}.`
    )
  })
  expect(calls).toBe(4)
})

const invalidRelations = [
  {
    label: "an existing target of a forbidden kind",
    target: ids.task,
    values: { basis: "wrong kind" },
    relationId: ids.invalid,
    message: "target"
  },
  {
    label: "a missing endpoint",
    target: ids.missing,
    values: { basis: "missing target" },
    relationId: ids.invalid,
    message: "missing target"
  },
  {
    label: "an undeclared relation field",
    target: ids.englishBread,
    values: { basis: "translation", freeNote: "undeclared" },
    relationId: ids.invalid,
    message: "undeclared field"
  },
  {
    label: "duplicate relation identities",
    target: ids.englishBread,
    values: { basis: "translation" },
    relationId: ids.extra,
    message: "already exists"
  }
]
it.each(invalidRelations)(
  "rejects $label atomically and returns the corrected accepted relations to the model",
  async ({ message, relationId, target, values }) => {
    let calls = 0
    await run(async (request) => {
      calls++
      if (calls === 1) return tool("apply_knowledge", seed, "seed-validation")
      if (calls === 2)
        return tool(
          "apply_knowledge",
          {
            reason: "Attempt an atomic relation batch",
            types: [],
            creates: [],
            updates: [],
            relationCreates: [
              {
                id: ids.extra,
                type: "Translation",
                source: ids.french,
                target: ids.englishBread,
                values: { basis: "valid first relation" }
              },
              { id: relationId, type: "Translation", source: ids.french, target, values }
            ]
          },
          "invalid-relations"
        )
      if (calls === 3) {
        expect(lastToolResult(request)).toMatchObject({ _tag: "KnowledgeRejected" })
        expect(JSON.stringify(lastToolResult(request)).toLowerCase()).toContain(message)
        return tool("query_knowledge_neighborhood", neighborhood, "inspect-atomicity")
      }
      if (calls === 4) {
        const page = Schema.decodeUnknownSync(NeighborhoodPage)(lastToolResult(request))
        expect(page.revision).toBe(1)
        expect(page.relations.map((relation) => relation.id).sort()).toEqual(
          seed.relationCreates.map((relation) => relation.id).sort()
        )
        return tool(
          "apply_knowledge",
          {
            reason: "Correct the rejected relation",
            types: [],
            creates: [],
            updates: [],
            relationCreates: [
              {
                id: ids.extra,
                type: "Translation",
                source: ids.french,
                target: ids.englishBread,
                values: { basis: "corrected translation" }
              }
            ]
          },
          "corrected-relation"
        )
      }
      if (calls === 5) {
        expect(lastToolResult(request)).toMatchObject({ revision: 2, createdRelationIds: [ids.extra] })
        return tool("query_knowledge_neighborhood", neighborhood, "read-corrected-relation")
      }
      const page = Schema.decodeUnknownSync(NeighborhoodPage)(lastToolResult(request))
      expect(page.relations.find((relation) => relation.id === ids.extra)?.values).toEqual({
        basis: "corrected translation"
      })
      return answer("The corrected translation relates French pain to English bread.")
    })
    expect(calls).toBe(6)
  }
)

it("updates relation endpoints and metadata while retaining the same stable relation identity", async () => {
  let calls = 0
  await run(async (request) => {
    calls++
    if (calls === 1) return tool("apply_knowledge", seed, "seed-update")
    if (calls === 2)
      return tool(
        "apply_knowledge",
        {
          reason: "Connect the English bread expression to a different personal episode",
          types: [],
          creates: [{ id: ids.missing, type: "Episode", values: { title: "Dinner in Paris" } }],
          updates: [],
          relationUpdates: [
            { id: ids.mnemonic, source: ids.englishBread, target: ids.missing, values: { cue: "bread at dinner" } }
          ]
        },
        "update-mnemonic"
      )
    if (calls === 3) {
      expect(lastToolResult(request)).toMatchObject({ revision: 2, updatedRelationIds: [ids.mnemonic] })
      return tool(
        "query_knowledge_neighborhood",
        { ...neighborhood, id: ids.englishBread, depth: 1 },
        "read-updated-mnemonic"
      )
    }
    const page = Schema.decodeUnknownSync(NeighborhoodPage)(lastToolResult(request))
    expect(page.relations.find((relation) => relation.id === ids.mnemonic)).toEqual({
      id: ids.mnemonic,
      type: "PersonalMnemonic",
      source: ids.englishBread,
      target: ids.missing,
      values: { cue: "bread at dinner" }
    })
    return answer(
      `My updated cue is ${String(page.relations.find((relation) => relation.id === ids.mnemonic)?.values["cue"])}.`
    )
  })
  expect(calls).toBe(4)
})
