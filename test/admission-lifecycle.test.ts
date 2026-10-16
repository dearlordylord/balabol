import { Effect, Fiber, Layer, Stream } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import { AnswerGeneration } from "../src/answer-generation/index.ts"
import { replyLayer } from "./reply-fixture.ts"
import { temporaryDatabase } from "./memory-fixture.ts"

const answer = Layer.succeed(AnswerGeneration, {
  capabilities: { languages: ["en"], output: "text-deltas" },
  generate: (input) =>
    Stream.succeed({ kind: "Delta" as const, text: input.input, languageSpans: [] }).pipe(
      Stream.concat(Stream.succeed({ kind: "Completed" as const }))
    )
})

it("retains a handed input across capture close while a speech fence prevents its response", async () => {
  const database = await temporaryDatabase()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          const source = yield* conversation.openInputSource()
          const first = yield* conversation.fenceSpeech({
            capability: source,
            sequence: 1,
            fenceId: crypto.randomUUID()
          })
          const reservation = yield* conversation.registerInput({
            message: { deliveryId: crypto.randomUUID(), text: "retained input" },
            source: { capability: source, sequence: 1 }
          })
          const fence = { capability: source, sequence: 2, fenceId: crypto.randomUUID() }
          const applied = yield* conversation.fenceSpeech(fence)
          expect(applied.revision > first.revision).toBe(true)
          expect(yield* conversation.fenceSpeech(fence)).toEqual(applied)
          yield* conversation.closeInputSource(source)
          const receipt = yield* conversation.submitInput(reservation)
          expect(receipt.text).toBe("retained input")
          expect((yield* conversation.page({ limit: 100 })).messages.filter((row) => row.role === "user")).toEqual([
            receipt
          ])
          const reply = yield* conversation.reply(receipt.deliveryId)
          expect(reply.state).toBe("Interrupted")
          expect(reply.text).toBe("")
        })
      ).pipe(Effect.provide(replyLayer(database.path, answer)))
    )
  } finally {
    await database.close()
  }
})

it("starts eligible input once and keeps duplicate delivery idempotent", async () => {
  const database = await temporaryDatabase()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          const message = { deliveryId: crypto.randomUUID(), text: "eligible input" }
          const reservation = yield* conversation.registerInput({ message })
          const scope = yield* Effect.scope
          const pending = yield* conversation.submitInput(reservation).pipe(Effect.forkIn(scope))
          const receipt = yield* conversation.send(message)
          expect(yield* Fiber.join(pending)).toEqual(receipt)
          const observer = yield* conversation.observeReply(message.deliveryId)
          expect(observer.length).toBeGreaterThan(0)
          let reply = yield* conversation.reply(message.deliveryId)
          for (let i = 0; reply.state !== "Completed" && i < 100; i++) {
            yield* Effect.sleep(5)
            reply = yield* conversation.reply(message.deliveryId)
          }
          expect(reply.text).toBe(message.text)
          expect(reply.state).toBe("Completed")
          expect(yield* conversation.send(message)).toEqual(receipt)
          expect((yield* conversation.page({ limit: 100 })).messages).toHaveLength(2)
        })
      ).pipe(Effect.provide(replyLayer(database.path, answer)))
    )
  } finally {
    await database.close()
  }
})
