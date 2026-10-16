import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { expect, it } from "vitest"
import { AnswerGeneration, type AnswerEvent } from "../src/answer-generation/index.ts"
import { Conversation } from "../src/conversation/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { replyLayer, waitForReply } from "./reply-fixture.ts"

it("awaits provider release outside the owner loop while fresh input intent remains processable", async () => {
  const database = await temporaryDatabase()
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const releasing = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const returned = yield* Deferred.make<void>()
        let calls = 0
        const provider = Layer.succeed(AnswerGeneration, {
          capabilities: { languages: ["en"], output: "text-deltas" },
          generate: () => {
            calls++
            if (calls !== 1)
              return Stream.fromIterable([
                { kind: "Delta", text: "Ready after cleanup.", languageSpans: [] },
                { kind: "Completed" }
              ] satisfies readonly AnswerEvent[])
            return Stream.fromEffect(Deferred.succeed(entered, undefined)).pipe(
              Stream.flatMap(() => Stream.never),
              Stream.ensuring(Deferred.succeed(releasing, undefined).pipe(Effect.andThen(Deferred.await(release))))
            )
          }
        })
        yield* Effect.gen(function* () {
          const conversation = yield* Conversation
          const input = yield* conversation.send({ deliveryId: crypto.randomUUID(), text: "first" })
          yield* Deferred.await(entered).pipe(Effect.timeout("2 seconds"))
          const cancellation = yield* conversation
            .cancelReply(input.deliveryId)
            .pipe(Effect.ensuring(Deferred.succeed(returned, undefined)), Effect.forkChild)
          yield* Deferred.await(releasing).pipe(Effect.timeout("2 seconds"))
          expect((yield* conversation.reply(input.deliveryId)).error?.code).toBe("Cancelled")
          const next = { deliveryId: crypto.randomUUID(), text: "next" }
          const reservation = yield* conversation.registerInput({ message: next }).pipe(Effect.timeout("2 seconds"))
          expect(reservation.deliveryId).toBe(next.deliveryId)
          expect(yield* Deferred.isDone(returned)).toBe(false)
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(cancellation).pipe(Effect.timeout("2 seconds"))
          yield* conversation.submitInput(reservation)
          const completed = yield* waitForReply(conversation, next.deliveryId)
          expect(completed.state).toBe("Completed")
          expect(completed.text).toBe("Ready after cleanup.")
          expect(calls).toBe(2)
          expect((yield* conversation.page({ limit: 100 })).messages.map((message) => message.role)).toEqual([
            "user",
            "user",
            "assistant"
          ])
        }).pipe(
          Effect.ensuring(Deferred.succeed(release, undefined)),
          Effect.scoped,
          Effect.provide(replyLayer(database.path, provider))
        )
      })
    )
  } finally {
    await database.close()
  }
})
