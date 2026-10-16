import { Effect } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import { KnowledgeUnavailable } from "../src/personal-knowledge/index.ts"
import { knowledgeAnswerLayer } from "./knowledge-answer-fixture.ts"
import { answer, lastToolResult, tool } from "./knowledge-tool-frames.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { replyLayer, waitForReply } from "./reply-fixture.ts"

const inputId = "11111111-1111-4111-8111-111111111111"
const entityId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const relationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const change = {
  reason: "Keep a concrete personal practice target",
  types: [{ name: "PracticeTarget", fields: [{ name: "minutes", kind: "number", required: true }] }],
  creates: [{ id: entityId, type: "PracticeTarget", values: { minutes: 15 } }],
  updates: [],
  relationTypes: [{ name: "Reinforces", sources: ["PracticeTarget"], targets: ["PracticeTarget"], fields: [] }],
  relationCreates: [{ id: relationId, type: "Reinforces", source: entityId, target: entityId, values: {} }]
}
const latch = () => {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}
const settings = { answerProvider: "subscription", answerModel: "gpt-6.1-sol" } as const

it.each(["before", "after"] as const)(
  "cancellation %s commit preserves the exact durable boundary and releases the lock",
  async (boundary) => {
    const database = await temporaryDatabase()
    const entered = latch()
    const release = latch()
    let gated = true
    let calls = 0
    const provider = knowledgeAnswerLayer(
      async (request) => {
        calls++
        if (calls === 1) return tool("apply_knowledge", change, "save-target")
        if (calls === 2) {
          const user = request.input.find((item) => "role" in item && item.role === "user")
          if (user === undefined || !("content" in user)) throw new Error("Missing current input")
          const initial = JSON.parse(JSON.parse(user.content))
          expect(initial.acceptedKnowledgeOperations.receipts).toHaveLength(boundary === "after" ? 1 : 0)
          return tool("apply_knowledge", change, "new-provider-call-on-retry")
        }
        expect(lastToolResult(request)).toMatchObject({
          revision: 1,
          createdIds: [entityId],
          createdRelationIds: [relationId]
        })
        return answer("The target is saved exactly once.")
      },
      (durable) => ({
        ...durable,
        commit: (request) =>
          Effect.gen(function* () {
            if (!gated) return yield* durable.commit(request)
            gated = false
            if (boundary === "before") {
              entered.resolve()
              yield* Effect.promise(() => release.promise)
              return yield* durable.commit(request)
            }
            const receipt = yield* durable.commit(request)
            entered.resolve()
            yield* Effect.promise(() => release.promise)
            return receipt
          })
      })
    )
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const conversation = yield* Conversation
            yield* conversation.send({ deliveryId: inputId, text: "Save my practice target." })
            yield* Effect.promise(() => entered.promise)
            yield* conversation.cancelReply(inputId)
            release.resolve()
            expect((yield* conversation.reply(inputId)).error?.code).toBe("Cancelled")
            expect((yield* conversation.receipt(inputId))?.text).toBe("Save my practice target.")
            yield* conversation.retryReply(inputId)
            const reply = yield* waitForReply(conversation, inputId)
            expect(reply.state).toBe("Completed")
            expect(reply.text).toBe("The target is saved exactly once.")
          })
        ).pipe(Effect.provide(replyLayer(database.path, provider, settings)))
      )
      expect(calls).toBe(3)
    } finally {
      release.resolve()
      await database.close()
    }
  }
)

it("does not let a model acknowledge an unavailable knowledge commit", async () => {
  const database = await temporaryDatabase()
  let calls = 0
  const provider = knowledgeAnswerLayer(
    async () => {
      calls++
      return calls === 1 ? tool("apply_knowledge", change, "unavailable") : answer("Saved!")
    },
    (durable) => ({
      ...durable,
      commit: () => Effect.fail(new KnowledgeUnavailable({ message: "Storage is unavailable" }))
    })
  )
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          yield* conversation.send({ deliveryId: inputId, text: "Save my practice target." })
          const reply = yield* waitForReply(conversation, inputId)
          expect(reply.state).toBe("Failed")
          expect(reply.text).toBe("")
          expect((yield* conversation.page({ limit: 100 })).messages).toHaveLength(1)
        })
      ).pipe(Effect.provide(replyLayer(database.path, provider, settings)))
    )
    expect(calls).toBe(1)
  } finally {
    await database.close()
  }
})
