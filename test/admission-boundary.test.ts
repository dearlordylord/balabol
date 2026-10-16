import { Effect } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { replyLayer } from "./reply-fixture.ts"
import { temporaryDatabase } from "./memory-fixture.ts"

it("rejects malformed, conflicting and retired input identities without saving or advancing a fence", async () => {
  const database = await temporaryDatabase()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          const source = yield* conversation.openInputSource()
          const message = { deliveryId: crypto.randomUUID(), text: "reserved payload" }
          const reservation = yield* conversation.registerInput({
            message,
            source: { capability: source, sequence: 0 }
          })
          const conflict = yield* conversation
            .registerInput({ message: { ...message, text: "other payload" } })
            .pipe(Effect.result)
          expect(conflict._tag).toBe("Failure")
          for (const sequence of [-1, 1.5, 281474976710656]) {
            expect(
              (yield* conversation
                .registerInput({ message, source: { capability: source, sequence } })
                .pipe(Effect.result))._tag
            ).toBe("Failure")
            expect(
              (yield* conversation
                .fenceSpeech({ capability: source, sequence, fenceId: crypto.randomUUID() })
                .pipe(Effect.result))._tag
            ).toBe("Failure")
          }
          expect(
            (yield* conversation.submitInput({ ...reservation, deliveryId: crypto.randomUUID() }).pipe(Effect.result))
              ._tag
          ).toBe("Failure")
          expect(
            (yield* conversation.abandonInput({ ...reservation, operationId: 281474976710656n }).pipe(Effect.result))
              ._tag
          ).toBe("Failure")
          const fence = { capability: source, sequence: 1, fenceId: crypto.randomUUID() }
          const acknowledgement = yield* conversation.fenceSpeech(fence)
          expect((yield* conversation.fenceSpeech({ ...fence, sequence: 2 }).pipe(Effect.result))._tag).toBe("Failure")
          expect(
            (yield* conversation.fenceSpeech({ ...fence, fenceId: crypto.randomUUID() }).pipe(Effect.result))._tag
          ).toBe("Failure")
          expect(yield* conversation.fenceSpeech(fence)).toEqual(acknowledgement)
          yield* conversation.abandonInput(reservation)
          expect((yield* conversation.submitInput(reservation).pipe(Effect.result))._tag).toBe("Failure")
          yield* conversation.closeInputSource(source)
          expect((yield* conversation.closeInputSource(source).pipe(Effect.result))._tag).toBe("Failure")
          expect(
            (yield* conversation
              .registerInput({ message, source: { capability: source, sequence: 1 } })
              .pipe(Effect.result))._tag
          ).toBe("Failure")
          const replacement = yield* conversation.openInputSource()
          expect(replacement > source).toBe(true)
          expect((yield* conversation.fenceSpeech(fence).pipe(Effect.result))._tag).toBe("Failure")
          expect((yield* conversation.page({ limit: 100 })).messages).toEqual([])
        })
      ).pipe(Effect.provide(replyLayer(database.path, fakeAnswerLayer(0))))
    )
  } finally {
    await database.close()
  }
})

it("bounds handed input reservations while allowing fences, exact retries and explicit abandonment", async () => {
  const database = await temporaryDatabase()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          const source = yield* conversation.openInputSource()
          const firstMessage = { deliveryId: crypto.randomUUID(), text: "first reservation" }
          const first = yield* conversation.registerInput({ message: firstMessage })
          const second = yield* conversation.registerInput({
            message: { deliveryId: crypto.randomUUID(), text: "second reservation" }
          })
          const third = { deliveryId: crypto.randomUUID(), text: "third reservation" }
          const full = yield* conversation.registerInput({ message: third }).pipe(Effect.result)
          expect(full._tag === "Failure" && full.failure._tag).toBe("ReplyBusy")
          expect(yield* conversation.registerInput({ message: firstMessage })).toEqual(first)
          yield* conversation.fenceSpeech({ capability: source, sequence: 1, fenceId: crypto.randomUUID() })
          yield* conversation.abandonInput(first)
          const available = yield* conversation.registerInput({ message: third })
          expect(available.deliveryId).toBe(third.deliveryId)
          yield* conversation.abandonInput(second)
          yield* conversation.abandonInput(available)
          expect((yield* conversation.page({ limit: 100 })).messages).toEqual([])
        })
      ).pipe(Effect.provide(replyLayer(database.path, fakeAnswerLayer(0))))
    )
  } finally {
    await database.close()
  }
})
