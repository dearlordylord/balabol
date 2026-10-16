import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { expect, it } from "vitest"
import { AnswerGeneration, AnswerFailed, type AnswerEvent } from "../src/answer-generation/index.ts"
import { Conversation, ReplyConfiguration, defaultReplySettings } from "../src/conversation/index.ts"
import { Memory, sqliteLayer, uniiLayer } from "../src/memory/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { waitForReply } from "./reply-fixture.ts"

it("joins the active retry when an older overlapping memory recovery finishes later", async () => {
  const database = await temporaryDatabase()
  let recoveryCalls = 0
  let generationCalls = 0
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const firstEntered = yield* Deferred.make<void>()
          const secondEntered = yield* Deferred.make<void>()
          const releaseFirst = yield* Deferred.make<void>()
          const releaseSecond = yield* Deferred.make<void>()
          const providerEntered = yield* Deferred.make<void>()
          const finishProvider = yield* Deferred.make<void>()
          const memory = Layer.effect(
            Memory,
            Effect.gen(function* () {
              const real = yield* Memory
              return Memory.of({
                ...real,
                retryFailed: () =>
                  Effect.suspend(() => {
                    recoveryCalls += 1
                    const entered = recoveryCalls === 1 ? firstEntered : secondEntered
                    const release = recoveryCalls === 1 ? releaseFirst : releaseSecond
                    return Deferred.succeed(entered, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                      Effect.andThen(real.retryFailed())
                    )
                  })
              })
            })
          ).pipe(Layer.provide(uniiLayer.pipe(Layer.provide(sqliteLayer(database.path)))))
          const delta: AnswerEvent = { kind: "Delta", text: "one authoritative retry", languageSpans: [] }
          const completed: AnswerEvent = { kind: "Completed" }
          const answer = Layer.succeed(
            AnswerGeneration,
            AnswerGeneration.of({
              capabilities: { languages: ["en"], output: "text-deltas" },
              generate: () =>
                Stream.unwrap(
                  Effect.sync(() => {
                    generationCalls += 1
                    if (generationCalls === 1)
                      return Stream.fail(new AnswerFailed({ message: "initial provider failure" }))
                    return Stream.fromEffect(
                      Deferred.succeed(providerEntered, undefined).pipe(
                        Effect.andThen(Deferred.await(finishProvider)),
                        Effect.as(delta)
                      )
                    ).pipe(Stream.concat(Stream.succeed(completed)))
                  })
                )
            })
          )
          const application = Conversation.configuredLayer.pipe(
            Layer.provide(
              Layer.mergeAll(
                memory,
                answer,
                Layer.succeed(ReplyConfiguration, { ...defaultReplySettings, attachmentMillis: 60000 })
              )
            )
          )
          yield* Effect.gen(function* () {
            const conversation = yield* Conversation
            const input = yield* conversation.send({ deliveryId: crypto.randomUUID(), text: "retry this input once" })
            const failed = yield* waitForReply(conversation, input.deliveryId)
            expect(failed.state).toBe("Failed")
            expect(failed.error?.code).toBe("ProviderFailed")
            const first = yield* conversation.retryReply(input.deliveryId).pipe(Effect.result, Effect.forkChild)
            yield* Deferred.await(firstEntered).pipe(Effect.timeout("2 seconds"))
            const second = yield* conversation.retryReply(input.deliveryId).pipe(Effect.result, Effect.forkChild)
            yield* Deferred.await(secondEntered).pipe(Effect.timeout("2 seconds"))
            expect(recoveryCalls).toBe(2)

            yield* Deferred.succeed(releaseFirst, undefined)
            const firstResult = yield* Fiber.join(first)
            if (firstResult._tag !== "Success")
              throw new Error("First released retry must establish the active attempt")
            const active = firstResult.success
            expect(active.responseId).not.toBe(failed.responseId)
            yield* Deferred.await(providerEntered).pipe(Effect.timeout("2 seconds"))
            yield* conversation.observeReply(input.deliveryId)
            expect(generationCalls).toBe(2)

            yield* Deferred.succeed(releaseSecond, undefined)
            const secondResult = yield* Fiber.join(second)
            if (secondResult._tag === "Success") expect(secondResult.success.responseId).toBe(active.responseId)
            else expect(secondResult.failure._tag).toBe("ReplyBusy")
            expect((yield* conversation.reply(input.deliveryId)).responseId).toBe(active.responseId)
            expect(generationCalls).toBe(2)

            yield* Deferred.succeed(finishProvider, undefined)
            const terminal = yield* waitForReply(conversation, input.deliveryId)
            expect(terminal.responseId).toBe(active.responseId)
            expect(terminal.state).toBe("Completed")
            expect(terminal.text).toBe("one authoritative retry")
            expect((yield* conversation.page({ limit: 100 })).messages).toEqual([input, terminal.receipt])
          }).pipe(
            Effect.ensuring(
              Effect.all(
                [
                  Deferred.succeed(releaseFirst, undefined),
                  Deferred.succeed(releaseSecond, undefined),
                  Deferred.succeed(finishProvider, undefined)
                ],
                { discard: true }
              )
            ),
            Effect.provide(application)
          )
        })
      )
    )
  } finally {
    await database.close()
  }
})
