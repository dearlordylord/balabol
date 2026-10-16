import { Effect, Layer, Schema } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import { KnowledgeSnapshot, NeighborhoodPage } from "../src/personal-knowledge/index.ts"
import { SummaryGeneration, type SummaryRequest } from "../src/summary-generation/index.ts"
import type { ToolInferenceRequest, ToolInferenceTransport } from "../src/subscription/index.ts"
import { knowledgeAnswerLayer } from "./knowledge-answer-fixture.ts"
import { answer, lastToolResult, tool } from "./knowledge-tool-frames.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { replyLayer, waitForReply } from "./reply-fixture.ts"

const id = (number: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${number.toString(16).padStart(12, "0")}`
const settings = { answerProvider: "subscription", answerModel: "gpt-6.1-sol" } as const
const prompt = (request: ToolInferenceRequest) => {
  const user = request.input.find((item) => "role" in item && item.role === "user")
  if (user === undefined || !("content" in user)) throw new Error("Missing explicit answer input")
  return Schema.decodeUnknownSync(Schema.Struct({ priorMemory: Schema.String, currentInput: Schema.String }))(
    JSON.parse(JSON.parse(user.content))
  )
}
const neighborhood = { id: id(1), depth: 1, direction: "outgoing", limit: 10 }
const selectedValues = (request: ToolInferenceRequest) => {
  const page = Schema.decodeUnknownSync(NeighborhoodPage)(lastToolResult(request))
  const relation = page.relations[0]
  const target = page.entities.find((entity) => entity.id === relation?.target)
  if (relation === undefined || target === undefined) throw new Error("Missing accepted association")
  return { page, relation, target }
}
const latch = () => {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

it("qualifies empty discovery, typed associations, a result-derived reply, migration and canonical recall after reopen", async () => {
  const database = await temporaryDatabase()
  const inputs = [
    "Keep my bread expression and breakfast cue.",
    "Rename the expression and association fields.",
    "Recall my expression after restart."
  ]
  const replies: string[] = []
  let calls = 0
  const transport: ToolInferenceTransport = async (request) => {
    calls++
    if (calls === 1) {
      expect(prompt(request)).toMatchObject({ currentInput: inputs[0] })
      return tool("inspect_knowledge", {}, "qualification-empty")
    }
    if (calls === 2) {
      expect(Schema.decodeUnknownSync(KnowledgeSnapshot)(lastToolResult(request))).toEqual({
        revision: 0,
        schema: { types: [], relations: [] }
      })
      return tool(
        "apply_knowledge",
        {
          reason: "Keep the user's explicit expression and personal breakfast association",
          types: [
            {
              name: "Expression",
              fields: [
                { name: "text", kind: "string", required: true },
                { name: "language", kind: "string", required: true }
              ]
            },
            { name: "Episode", fields: [{ name: "title", kind: "string", required: true }] }
          ],
          creates: [
            { id: id(1), type: "Expression", values: { text: "pain", language: "fr" } },
            { id: id(2), type: "Episode", values: { title: "Breakfast in Paris" } }
          ],
          updates: [],
          relationTypes: [
            {
              name: "PersonalMnemonic",
              sources: ["Expression"],
              targets: ["Episode"],
              fields: [{ name: "cue", kind: "string", required: true }]
            }
          ],
          relationCreates: [
            { id: id(3), type: "PersonalMnemonic", source: id(1), target: id(2), values: { cue: "bread at breakfast" } }
          ]
        },
        "qualification-save"
      )
    }
    if (calls === 3) {
      expect(lastToolResult(request)).toMatchObject({
        revision: 1,
        createdIds: [id(1), id(2)],
        createdRelationIds: [id(3)]
      })
      return tool("query_knowledge_neighborhood", neighborhood, "qualification-use")
    }
    if (calls === 4) {
      const { page, relation, target } = selectedValues(request)
      replies.push(
        `${page.root.values.text} (${page.root.values.language}): ${relation.values.cue}, ${target.values.title}.`
      )
      return answer(replies[0] ?? "Missing first reply")
    }
    if (calls === 5) {
      const context = prompt(request)
      expect(context.currentInput).toBe(inputs[1])
      expect(context.priorMemory).toContain(inputs[0])
      expect(context.priorMemory).toContain(replies[0])
      expect(context.priorMemory).not.toContain("qualification-save")
      expect(context.priorMemory).not.toContain(id(3))
      return tool(
        "apply_knowledge",
        {
          reason: "Clarify the saved field names without replacing their values",
          types: [],
          creates: [],
          updates: [],
          migrations: [
            { kind: "RenameField", target: "entity", type: "Expression", from: "text", to: "word" },
            { kind: "RenameField", target: "relation", type: "PersonalMnemonic", from: "cue", to: "hint" }
          ]
        },
        "qualification-migrate"
      )
    }
    if (calls === 6) {
      expect(lastToolResult(request)).toMatchObject({ revision: 2 })
      return tool("query_knowledge_neighborhood", neighborhood, "qualification-migrated")
    }
    if (calls === 7) {
      const { page, relation, target } = selectedValues(request)
      expect(page.revision).toBe(2)
      expect(page.root.values).not.toHaveProperty("text")
      expect(relation.values).not.toHaveProperty("cue")
      replies.push(`${page.root.values.word}: ${relation.values.hint}, ${target.values.title}.`)
      return answer(replies[1] ?? "Missing migrated reply")
    }
    if (calls === 8) {
      const context = prompt(request)
      expect(context.currentInput).toBe(inputs[2])
      expect(context.priorMemory).toContain(inputs[1])
      expect(context.priorMemory).toContain(replies[1])
      expect(context.priorMemory).not.toContain("qualification-migrate")
      return tool("query_knowledge_neighborhood", neighborhood, "qualification-reopened")
    }
    const { page, relation, target } = selectedValues(request)
    expect(page.revision).toBe(2)
    expect([page.root.id, target.id, relation.id]).toEqual([id(1), id(2), id(3)])
    replies.push(`${page.root.values.word}: ${relation.values.hint}, ${target.values.title}.`)
    return answer(replies[2] ?? "Missing reopened reply")
  }
  const application = replyLayer(database.path, knowledgeAnswerLayer(transport), settings)
  try {
    for (let phase = 0; phase < inputs.length; phase++) {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const conversation = yield* Conversation
            const text = inputs[phase]
            if (text === undefined) throw new Error("Missing accepted input")
            const deliveryId = id(100 + phase)
            yield* conversation.send({ deliveryId, text })
            const reply = yield* waitForReply(conversation, deliveryId)
            expect(reply.state).toBe("Completed")
            expect(reply.text).toBe(replies[phase])
            const transcript = (yield* conversation.page({ limit: 100 })).messages
            expect(transcript.map((message) => message.text)).toEqual(
              inputs.slice(0, phase + 1).flatMap((input, index) => [input, replies[index]])
            )
            for (const message of transcript.filter((message) => message.role === "assistant")) {
              expect(message.text).not.toContain("function_call")
              expect(message.text).not.toContain("qualification-")
              expect(message.text).not.toContain(id(1))
              expect(message.text).not.toContain("createdIds")
            }
          }).pipe(Effect.provide(application))
        )
      )
    }
    expect(replies).toEqual([
      "pain (fr): bread at breakfast, Breakfast in Paris.",
      "pain: bread at breakfast, Breakfast in Paris.",
      "pain: bread at breakfast, Breakfast in Paris."
    ])
  } finally {
    await database.close()
  }
})

it("keeps canonical unii summaries independent when a pending knowledge tool and its answer are interrupted", async () => {
  const database = await temporaryDatabase()
  const summaryEntered = latch()
  const summaryRelease = latch()
  const toolEntered = latch()
  const toolRelease = latch()
  const requests: SummaryRequest[] = []
  let summaryReleased = false
  let summaryCancelled = false
  let activeSummaries = 0
  const summary = Layer.succeed(SummaryGeneration, {
    summarize: (request) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          requests.push(request)
          activeSummaries++
          summaryEntered.resolve()
        }),
        () => Effect.promise(() => summaryRelease.promise).pipe(Effect.as("Retained independent user facts.")),
        () =>
          Effect.sync(() => {
            activeSummaries--
            if (!summaryReleased) summaryCancelled = true
          })
      )
  })
  let calls = 0
  const provider = knowledgeAnswerLayer(
    async (request) => {
      calls++
      if (calls === 1) return tool("inspect_knowledge", {}, "qualification-summary-tool")
      const current = prompt(request)
      expect(current.currentInput).toBe("Use my retained facts now.")
      expect(current.priorMemory).toContain("Retained independent user facts.")
      expect(current.priorMemory).not.toContain("qualification-summary-tool")
      return answer("I used the independently retained conversation facts.")
    },
    (durable) => ({
      ...durable,
      current: () =>
        Effect.gen(function* () {
          toolEntered.resolve()
          yield* Effect.promise(() => toolRelease.promise)
          return yield* durable.current()
        })
    })
  )
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          yield* conversation.send({ deliveryId: id(200), text: "Previously accepted conversation facts. ".repeat(80) })
          yield* Effect.promise(() => Promise.all([summaryEntered.promise, toolEntered.promise]))
          expect(activeSummaries).toBeGreaterThan(0)
          yield* conversation.cancelReply(id(200))
          toolRelease.resolve()
          expect((yield* conversation.reply(id(200))).error?.code).toBe("Cancelled")
          expect(summaryCancelled).toBe(false)
          expect(activeSummaries).toBeGreaterThan(0)
          yield* conversation.send({ deliveryId: id(201), text: "Use my retained facts now." })
          expect((yield* conversation.reply(id(201))).state).toBe("Waiting")
          summaryReleased = true
          summaryRelease.resolve()
          const reply = yield* waitForReply(conversation, id(201))
          expect(reply.state).toBe("Completed")
          expect(reply.text).toBe("I used the independently retained conversation facts.")
          expect(summaryCancelled).toBe(false)
          expect(calls).toBe(2)
          expect(requests.length).toBeGreaterThan(0)
          for (const request of requests) {
            const source = JSON.stringify(request)
            expect(source).not.toContain("qualification-summary-tool")
            expect(source).not.toContain("function_call")
            expect(source).not.toContain("inspect_knowledge")
            expect(source).not.toContain("createdIds")
            expect(request).not.toHaveProperty("tools")
          }
          const transcript = (yield* conversation.page({ limit: 100 })).messages
          expect(transcript.filter((message) => message.role === "assistant").map((message) => message.text)).toEqual([
            reply.text
          ])
        }).pipe(
          Effect.provide(
            replyLayer(
              database.path,
              provider,
              { ...settings, contextWaitAttempts: 300, contextWaitMillis: 5 },
              summary
            )
          )
        )
      )
    )
  } finally {
    summaryReleased = true
    summaryRelease.resolve()
    toolRelease.resolve()
    await database.close()
  }
})
