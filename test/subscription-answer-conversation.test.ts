import { Effect } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { knowledgeAnswerLayer } from "./knowledge-answer-fixture.ts"
import { replyLayer, waitForReply } from "./reply-fixture.ts"
const input = { deliveryId: "11111111-1111-4111-8111-111111111111", text: "synthetic input" }
const later = { deliveryId: "22222222-2222-4222-8222-222222222222", text: "synthetic followup" }
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
const success =
  event({ type: "response.output_text.delta", delta: "synthetic answer" }) +
  event({ type: "response.completed", response: { status: "completed", output: [] } })
it("durably streams real-adapter output once across duplicate delivery and reconnect", async () => {
  const database = await temporaryDatabase()
  let calls = 0
  const answer = knowledgeAnswerLayer(async () => {
    calls++
    return new Response(success)
  })
  const application = replyLayer(database.path, answer, { answerProvider: "subscription", answerModel: "gpt-6.1-sol" })
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          yield* conversation.send(input)
          const receipt = yield* conversation.send(input)
          const completed = yield* waitForReply(conversation, input.deliveryId)
          expect(completed.state).toBe("Completed")
          expect(completed.text).toBe("synthetic answer")
          expect(completed.languageSpans).toEqual([])
          expect((yield* conversation.send(input)).position).toBe(receipt.position)
        })
      ).pipe(Effect.provide(application))
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          yield* conversation.send(input)
          expect((yield* conversation.reply(input.deliveryId)).state).toBe("Completed")
          expect((yield* conversation.page({ limit: 100 })).messages).toHaveLength(2)
        })
      ).pipe(Effect.provide(application))
    )
    expect(calls).toBe(1)
  } finally {
    await database.close()
  }
})
it("a quota failure leaves accepted memory and permits the next real-adapter answer without restart", async () => {
  const database = await temporaryDatabase()
  let calls = 0
  const answer = knowledgeAnswerLayer(async (request) => {
    if (calls++ === 0)
      return new Response(
        event({ type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded" } } })
      )
    expect(JSON.stringify(request.input)).toContain("synthetic input")
    return new Response(success)
  })
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          yield* conversation.send(input)
          expect((yield* waitForReply(conversation, input.deliveryId)).state).toBe("Failed")
          yield* conversation.send(later)
          expect((yield* waitForReply(conversation, later.deliveryId)).state).toBe("Completed")
          expect((yield* conversation.page({ limit: 100 })).messages).toHaveLength(3)
        })
      ).pipe(
        Effect.provide(
          replyLayer(database.path, answer, { answerProvider: "subscription", answerModel: "gpt-6.1-sol" })
        )
      )
    )
  } finally {
    await database.close()
  }
})
it("selects the exact qualified model only after explicit opt-in and rejects unsupported configuration", async () => {
  const { parseConfig } = await import("../src/bootstrap/index.ts")
  const enabled = await Effect.runPromise(parseConfig({ BALABOL_ANSWER_PROVIDER: "subscription" }))
  expect(enabled.reply?.answerModel).toBe("gpt-6.1-sol")
  const defaults = await Effect.runPromise(parseConfig({}))
  expect(defaults.reply?.answerProvider).toBe("fake")
  const invalid = await Effect.runPromise(
    parseConfig({ BALABOL_ANSWER_PROVIDER: "subscription", BALABOL_ANSWER_MODEL: "unqualified" }).pipe(Effect.result)
  )
  expect(invalid._tag).toBe("Failure")
})

it.each([401, 403, 429])(
  "preserves the actionable subscription failure for HTTP %s through the agent runtime",
  async (status) => {
    const database = await temporaryDatabase()
    const answer = knowledgeAnswerLayer(
      async () => new Response("private provider details must not escape", { status })
    )
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const conversation = yield* Conversation
            yield* conversation.send(input)
            const reply = yield* waitForReply(conversation, input.deliveryId)
            expect(reply.state).toBe("Failed")
            expect(reply.error?.message).toContain(
              status === 429 ? "subscription usage limit" : "authentication failed"
            )
            expect(reply.error?.message).not.toContain("private provider details")
            expect(reply.error?.message).not.toContain("AI error")
          })
        ).pipe(
          Effect.provide(
            replyLayer(database.path, answer, { answerProvider: "subscription", answerModel: "gpt-6.1-sol" })
          )
        )
      )
    } finally {
      await database.close()
    }
  }
)
