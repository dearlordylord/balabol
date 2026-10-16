import { Deferred, Effect, Fiber, Layer } from "effect"
import { expect, it } from "vitest"
import { Conversation, ReplyConfiguration, defaultReplySettings } from "../src/conversation/index.ts"
import { Memory, uniiLayer, sqliteLayer } from "../src/memory/index.ts"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"

it("retains an already selected completion when interruption arrives during its durable write", async () => {
  const database = await temporaryDatabase()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const writing = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const memory = Layer.effect(
            Memory,
            Effect.gen(function* () {
              const real = yield* Memory
              return Memory.of({
                ...real,
                append: (payload) =>
                  payload.outcome === "completed"
                    ? Deferred.succeed(writing, undefined).pipe(
                        Effect.andThen(Deferred.await(release)),
                        Effect.andThen(real.append(payload))
                      )
                    : real.append(payload)
              })
            })
          ).pipe(Layer.provide(uniiLayer.pipe(Layer.provide(sqliteLayer(database.path)))))
          const application = Conversation.configuredLayer.pipe(
            Layer.provide(
              Layer.mergeAll(memory, fakeAnswerLayer(0), Layer.succeed(ReplyConfiguration, defaultReplySettings))
            )
          )
          yield* Effect.gen(function* () {
            const conversation = yield* Conversation
            const scope = yield* Effect.scope
            const input = yield* conversation.send({
              deliveryId: crypto.randomUUID(),
              text: "complete before interrupt"
            })
            yield* Deferred.await(writing).pipe(Effect.timeout("2 seconds"))
            const selected = yield* conversation.reply(input.deliveryId)
            expect(selected.text).not.toBe("")
            const interruption = yield* conversation
              .interruptResponse({ responseId: selected.responseId, inputDeliveryId: input.deliveryId })
              .pipe(Effect.forkIn(scope))
            yield* Effect.yieldNow
            yield* Deferred.succeed(release, undefined)
            const reply = yield* Fiber.join(interruption)
            expect(reply?.state).toBe("Completed")
            expect(reply?.text).toBe(selected.text)
            expect(reply?.receipt?.outcome).toBe("completed")
            expect((yield* conversation.page({ limit: 100 })).messages.map((message) => message.text)).toEqual([
              input.text,
              selected.text
            ])
          }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)), Effect.provide(application))
        })
      )
    )
  } finally {
    await database.close()
  }
})
