import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope, Stream } from "effect"
import { expect, it } from "vitest"
import { AnswerFailed, AnswerGeneration } from "../src/answer-generation/index.ts"
import { Conversation, defaultReplySettings, ReplyConfiguration } from "../src/conversation/index.ts"
import { Memory, sqliteLayer, uniiLayer } from "../src/memory/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { waitForReply } from "./reply-fixture.ts"

it("fails an outer retry caller when its Conversation resource scope closes", async () => {
  const database = await temporaryDatabase()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const reading = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const readStopped = yield* Deferred.make<void>()
          let blocking = false
          const memory = Layer.effect(
            Memory,
            Effect.gen(function* () {
              const real = yield* Memory
              return Memory.of({
                ...real,
                latestInput: () =>
                  blocking
                    ? Deferred.succeed(reading, undefined).pipe(
                        Effect.andThen(Deferred.await(release)),
                        Effect.andThen(real.latestInput()),
                        Effect.ensuring(Deferred.succeed(readStopped, undefined))
                      )
                    : real.latestInput()
              })
            })
          ).pipe(Layer.provide(uniiLayer.pipe(Layer.provide(sqliteLayer(database.path)))))
          const answer = Layer.succeed(
            AnswerGeneration,
            AnswerGeneration.of({
              capabilities: { languages: ["en"], output: "text-deltas" },
              generate: () => Stream.fail(new AnswerFailed({ message: "Fixture permits explicit retry" }))
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
          const serviceScope = yield* Scope.make()
          yield* Effect.addFinalizer(() => Scope.close(serviceScope, Exit.void))
          const context = yield* Layer.buildWithScope(application, serviceScope)
          const conversation = Context.get(context, Conversation)
          const input = yield* conversation.send({ deliveryId: crypto.randomUUID(), text: "retry after owner closes" })
          expect((yield* waitForReply(conversation, input.deliveryId)).state).toBe("Failed")
          blocking = true
          const retry = yield* conversation.retryReply(input.deliveryId).pipe(Effect.result, Effect.forkChild)
          yield* Deferred.await(reading).pipe(Effect.timeout("2 seconds"))
          expect(retry.pollUnsafe()).toBeUndefined()
          yield* Scope.close(serviceScope, Exit.void).pipe(Effect.timeout("2 seconds"))
          yield* Deferred.await(readStopped).pipe(Effect.timeout("2 seconds"))
          const result = yield* Fiber.join(retry).pipe(Effect.timeout("2 seconds"))
          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure") expect(result.failure._tag).toBe("StorageUnavailable")
          const subsequent = yield* conversation
            .retryReply(input.deliveryId)
            .pipe(Effect.result, Effect.timeout("2 seconds"))
          expect(subsequent._tag).toBe("Failure")
          if (subsequent._tag === "Failure") expect(subsequent.failure._tag).toBe("StorageUnavailable")
        })
      )
    )
  } finally {
    await database.close()
  }
})
