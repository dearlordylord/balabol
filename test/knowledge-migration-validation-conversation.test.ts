import { Effect, Schema } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import { QueryPage, RevisionPage } from "../src/personal-knowledge/index.ts"
import type { ToolInferenceTransport } from "../src/subscription/index.ts"
import { knowledgeAnswerLayer } from "./knowledge-answer-fixture.ts"
import { answer, lastToolResult, tool } from "./knowledge-tool-frames.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { replyLayer, waitForReply } from "./reply-fixture.ts"

const firstId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const secondId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const thirdId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const seed = {
  reason: "Remember two records with different optional-field presence",
  types: [
    {
      name: "Item",
      fields: [
        { name: "label", kind: "string", required: true },
        { name: "memo", kind: "string", required: false }
      ]
    }
  ],
  creates: [
    { id: firstId, type: "Item", values: { label: "bread", memo: "bakery" } },
    { id: secondId, type: "Item", values: { label: "passport" } }
  ],
  updates: []
}
const corrected = {
  reason: "Rename the label, add typed defaults and create against the resulting schema",
  types: [],
  creates: [{ id: thirdId, type: "Item", values: { title: "new item", active: true, score: 7 } }],
  updates: [],
  migrations: [
    { kind: "RenameField", target: "entity", type: "Item", from: "label", to: "title" },
    { kind: "RenameField", target: "entity", type: "Item", from: "memo", to: "note" },
    {
      kind: "AddField",
      target: "entity",
      type: "Item",
      field: { name: "active", kind: "boolean", required: true },
      default: false
    },
    {
      kind: "AddField",
      target: "entity",
      type: "Item",
      field: { name: "score", kind: "number", required: true },
      default: 0
    },
    {
      kind: "AddField",
      target: "entity",
      type: "Item",
      field: { name: "explanation", kind: "string", required: false }
    }
  ]
}
const defaultReply = "The bread item retains its memo, and its active flag is false with score zero."
const run = async (transport: ToolInferenceTransport, expectedReply = defaultReply) => {
  const database = await temporaryDatabase()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          const input = {
            deliveryId: "11111111-1111-4111-8111-111111111111",
            text: "Improve the structure of my saved items."
          }
          yield* conversation.send(input)
          const reply = yield* waitForReply(conversation, input.deliveryId)
          expect(reply.state).toBe("Completed")
          expect(reply.text).toBe(expectedReply)
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
const rejections = [
  {
    label: "an already declared added field",
    migrations: [
      {
        kind: "AddField",
        target: "entity",
        type: "Item",
        field: { name: "label", kind: "string", required: true },
        default: "replacement"
      }
    ],
    tag: "KnowledgeRejected",
    message: "already exists"
  },
  {
    label: "a wrong default scalar",
    migrations: [
      {
        kind: "AddField",
        target: "entity",
        type: "Item",
        field: { name: "score", kind: "number", required: true },
        default: "wrong"
      }
    ],
    tag: "KnowledgeRejected",
    message: "score"
  },
  {
    label: "a missing required default",
    migrations: [
      { kind: "AddField", target: "entity", type: "Item", field: { name: "active", kind: "boolean", required: true } }
    ],
    tag: "KnowledgeRejected",
    message: "default"
  },
  {
    label: "a rename collision",
    migrations: [{ kind: "RenameField", target: "entity", type: "Item", from: "label", to: "memo" }],
    tag: "KnowledgeRejected",
    message: "memo"
  },
  {
    label: "a missing rename source",
    migrations: [{ kind: "RenameField", target: "entity", type: "Item", from: "absent", to: "title" }],
    tag: "KnowledgeRejected",
    message: "absent"
  },
  {
    label: "an unsupported migration operation",
    migrations: [{ kind: "DeleteField", target: "entity", type: "Item", name: "label" }],
    tag: "AiError",
    message: "ToolParameterValidationError"
  },
  {
    label: "a failing second migration after a valid in-memory rename",
    migrations: [
      { kind: "RenameField", target: "entity", type: "Item", from: "label", to: "title" },
      { kind: "AddField", target: "entity", type: "Item", field: { name: "active", kind: "boolean", required: true } }
    ],
    tag: "KnowledgeRejected",
    message: "default"
  }
]
it.each(rejections)(
  "rejects $label without publishing schema, values or history and lets the model correct the batch",
  async ({ message, migrations, tag }) => {
    let calls = 0
    await run(async (request) => {
      calls++
      if (calls === 1) return tool("apply_knowledge", seed, "seed-items")
      if (calls === 2) {
        expect(lastToolResult(request)).toMatchObject({ revision: 1 })
        return tool(
          "apply_knowledge",
          { reason: "Attempt a declarative migration", types: [], creates: [], updates: [], migrations },
          "rejected-migration"
        )
      }
      if (calls === 3) {
        expect(lastToolResult(request)).toMatchObject({ _tag: tag })
        expect(JSON.stringify(lastToolResult(request)).toLowerCase()).toContain(message.toLowerCase())
        return tool("inspect_knowledge_history", { limit: 20 }, "inspect-unpublished-history")
      }
      if (calls === 4) {
        const history = Schema.decodeUnknownSync(RevisionPage)(lastToolResult(request))
        expect(history.revisions.map((revision) => revision.revision)).toEqual([0, 1])
        expect(history.nextAfterRevision).toBeNull()
        return tool("query_knowledge", { type: "Item", limit: 10 }, "read-unchanged-items")
      }
      if (calls === 5) {
        const page = Schema.decodeUnknownSync(QueryPage)(lastToolResult(request))
        expect(page.revision).toBe(1)
        expect(page.entities).toEqual(seed.creates)
        expect(page.schema.types).toEqual(seed.types)
        return tool("apply_knowledge", corrected, "correct-migration")
      }
      if (calls === 6) {
        expect(lastToolResult(request)).toMatchObject({ revision: 2, createdIds: [thirdId] })
        return tool("query_knowledge", { type: "Item", limit: 10 }, "consume-migrated-values")
      }
      const page = Schema.decodeUnknownSync(QueryPage)(lastToolResult(request))
      expect(page.revision).toBe(2)
      expect(page.entities).toEqual([
        { id: firstId, type: "Item", values: { title: "bread", note: "bakery", active: false, score: 0 } },
        { id: secondId, type: "Item", values: { title: "passport", active: false, score: 0 } },
        { id: thirdId, type: "Item", values: { title: "new item", active: true, score: 7 } }
      ])
      expect(page.schema.types[0]?.fields.map((field) => field.name)).toEqual([
        "title",
        "note",
        "active",
        "score",
        "explanation"
      ])
      const bread = page.entities.find((entity) => entity.id === firstId)
      expect(bread?.values["active"]).toBe(false)
      expect(bread?.values["score"]).toBe(0)
      return answer(
        `The ${String(bread?.values["title"])} item retains its memo, and its active flag is ${String(bread?.values["active"])} with score zero.`
      )
    })
    expect(calls).toBe(7)
  }
)

it("rejects a thirty-third declared field without publishing history and accepts a rename within the existing limit", async () => {
  const fields = [
    { name: "label", kind: "string", required: true },
    ...Array.from({ length: 31 }, (_, index) => ({ name: `optional${index}`, kind: "string", required: false }))
  ]
  let calls = 0
  const expectedReply = "The renamed bread item remains within the field limit."
  await run(async (request) => {
    calls++
    if (calls === 1)
      return tool(
        "apply_knowledge",
        {
          reason: "Keep a type at its declared field limit",
          types: [{ name: "Item", fields }],
          creates: [{ id: firstId, type: "Item", values: { label: "bread" } }],
          updates: []
        },
        "seed-field-limit"
      )
    if (calls === 2)
      return tool(
        "apply_knowledge",
        {
          reason: "Attempt to exceed the field limit",
          types: [],
          creates: [],
          updates: [],
          migrations: [
            {
              kind: "AddField",
              target: "entity",
              type: "Item",
              field: { name: "overflow", kind: "string", required: false }
            }
          ]
        },
        "exceed-field-limit"
      )
    if (calls === 3) {
      expect(lastToolResult(request)).toMatchObject({ _tag: "KnowledgeRejected", code: "LimitExceeded" })
      return tool("inspect_knowledge_history", { limit: 20 }, "read-field-limit-history")
    }
    if (calls === 4) {
      expect(
        Schema.decodeUnknownSync(RevisionPage)(lastToolResult(request)).revisions.map((revision) => revision.revision)
      ).toEqual([0, 1])
      return tool("query_knowledge", { type: "Item", limit: 10 }, "read-original-limited-schema")
    }
    if (calls === 5) {
      const page = Schema.decodeUnknownSync(QueryPage)(lastToolResult(request))
      expect(page.revision).toBe(1)
      expect(page.schema.types).toEqual([{ name: "Item", fields }])
      expect(page.entities).toEqual([{ id: firstId, type: "Item", values: { label: "bread" } }])
      return tool(
        "apply_knowledge",
        {
          reason: "Rename within the existing field limit",
          types: [],
          creates: [],
          updates: [],
          migrations: [{ kind: "RenameField", target: "entity", type: "Item", from: "label", to: "title" }]
        },
        "rename-within-limit"
      )
    }
    if (calls === 6) {
      expect(lastToolResult(request)).toMatchObject({ revision: 2 })
      return tool("query_knowledge", { type: "Item", limit: 10 }, "read-renamed-limited-schema")
    }
    const page = Schema.decodeUnknownSync(QueryPage)(lastToolResult(request))
    expect(page.revision).toBe(2)
    expect(page.schema.types[0]?.fields).toHaveLength(32)
    expect(page.entities).toEqual([{ id: firstId, type: "Item", values: { title: "bread" } }])
    return answer(expectedReply)
  }, expectedReply)
  expect(calls).toBe(7)
})

it("adds a required field without a default to an empty type and validates ordinary creation against the resulting schema", async () => {
  let calls = 0
  const expectedReply = "The first bread item supplies its required active flag."
  await run(async (request) => {
    calls++
    if (calls === 1)
      return tool(
        "apply_knowledge",
        {
          reason: "Declare an empty personal type",
          types: [{ name: "Item", fields: [{ name: "label", kind: "string", required: true }] }],
          creates: [],
          updates: []
        },
        "declare-empty-type"
      )
    if (calls === 2) {
      expect(lastToolResult(request)).toMatchObject({ revision: 1, createdIds: [] })
      return tool(
        "apply_knowledge",
        {
          reason: "Add a required field before the first instance",
          types: [],
          updates: [],
          migrations: [
            {
              kind: "AddField",
              target: "entity",
              type: "Item",
              field: { name: "active", kind: "boolean", required: true }
            }
          ],
          creates: [{ id: firstId, type: "Item", values: { label: "bread", active: true } }]
        },
        "add-required-field-to-empty-type"
      )
    }
    if (calls === 3) {
      expect(lastToolResult(request)).toMatchObject({ revision: 2, createdIds: [firstId] })
      return tool("query_knowledge", { type: "Item", limit: 10 }, "read-first-instance")
    }
    const page = Schema.decodeUnknownSync(QueryPage)(lastToolResult(request))
    expect(page.revision).toBe(2)
    expect(page.schema.types[0]?.fields).toEqual([
      { name: "label", kind: "string", required: true },
      { name: "active", kind: "boolean", required: true }
    ])
    expect(page.entities).toEqual([{ id: firstId, type: "Item", values: { label: "bread", active: true } }])
    return answer(expectedReply)
  }, expectedReply)
  expect(calls).toBe(4)
})
