import { randomUUID } from "node:crypto"
import { Effect, Layer, Stream } from "effect"
import { expect, it } from "vitest"
import { AnswerGeneration } from "../src/answer-generation/index.ts"
import { Conversation } from "../src/conversation/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { replyLayer, waitForReply } from "./reply-fixture.ts"

it("rejects unsupported emitted annotations before exposing or committing assistant output", async () => {
  const fixture = await temporaryDatabase()
  const provider = Layer.succeed(AnswerGeneration, {
    capabilities: { languages: ["en"], output: "text-deltas" },
    generate: () =>
      Stream.make(
        { kind: "Delta", text: "Hallo", languageSpans: [{ language: "de", start: 0, end: 5 }] },
        { kind: "Completed" }
      )
  })
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          const input = yield* conversation.send({ deliveryId: randomUUID(), text: "hello" })
          const reply = yield* waitForReply(conversation, input.deliveryId)
          expect(reply.state).toBe("Failed")
          expect(reply.error).toEqual({
            code: "ProviderFailed",
            message: "Provider emitted an unsupported answer language"
          })
          expect(reply.text).toBe("")
          expect(reply.languageSpans).toEqual([])
          expect(reply.receipt).toBeNull()
          expect((yield* conversation.page({ limit: 100 })).messages).toEqual([input])
        })
      ).pipe(Effect.provide(replyLayer(fixture.path, provider)))
    )
  } finally {
    await fixture.close()
  }
})

it.each([
  [{ language: "fr", start: 0, end: 5 }],
  [
    { language: "en", start: 0, end: 3 },
    { language: "fr", start: 3, end: 5 }
  ]
])(
  "rejects unsupported input metadata or response preference even when the provider ignores its contract (%j)",
  async (...spans) => {
    const fixture = await temporaryDatabase()
    const provider = Layer.succeed(AnswerGeneration, {
      capabilities: { languages: ["en"], output: "text-deltas" },
      generate: () => Stream.make({ kind: "Delta", text: "ok", languageSpans: [] }, { kind: "Completed" })
    })
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const conversation = yield* Conversation
            const input = yield* conversation.send({ deliveryId: randomUUID(), text: "hello", languageSpans: spans })
            const reply = yield* waitForReply(conversation, input.deliveryId)
            expect(reply.state).toBe("Failed")
            expect(reply.error?.message).toBe("Accepted input requires an unsupported answer language")
            expect(reply.receipt).toBeNull()
            expect((yield* conversation.page({ limit: 100 })).messages).toEqual([input])
          })
        ).pipe(Effect.provide(replyLayer(fixture.path, provider)))
      )
    } finally {
      await fixture.close()
    }
  }
)

it("rejects invalid selected capabilities as a typed startup failure", async () => {
  const fixture = await temporaryDatabase()
  const provider = Layer.succeed(AnswerGeneration, {
    capabilities: { languages: [], output: "text-deltas" },
    generate: () => Stream.never
  })
  try {
    const failure = await Effect.runPromise(
      Effect.flip(Effect.scoped(Conversation).pipe(Effect.provide(replyLayer(fixture.path, provider))))
    )
    expect(failure._tag).toBe("AnswerFailed")
    expect(failure.message).toBe("Invalid answer provider capabilities")
  } finally {
    await fixture.close()
  }
})
