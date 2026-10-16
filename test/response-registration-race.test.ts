import { Clock, Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { expect, it } from "vitest"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { Conversation, ReplyConfiguration, defaultReplySettings } from "../src/conversation/index.ts"
import { sqliteLayer, uniiLayer } from "../src/memory/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"

it("cannot publish a retired registration after its uninterruptible delivery preparation returns", async () => {
  const database = await temporaryDatabase()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const native = yield* Clock.Clock
          let blocking = true
          const clock = Layer.succeed(Clock.Clock, {
            currentTimeMillisUnsafe: () => native.currentTimeMillisUnsafe(),
            currentTimeNanosUnsafe: () => native.currentTimeNanosUnsafe(),
            currentTimeNanos: native.currentTimeNanos,
            monotonicTimeNanosUnsafe: () => native.monotonicTimeNanosUnsafe(),
            monotonicTimeNanos: native.monotonicTimeNanos,
            sleep: (duration) => native.sleep(duration),
            currentTimeMillis: Effect.suspend(() =>
              blocking
                ? Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(native.currentTimeMillis),
                    Effect.uninterruptible
                  )
                : native.currentTimeMillis
            )
          })
          const application = Conversation.configuredLayer.pipe(
            Layer.provide(
              Layer.mergeAll(
                uniiLayer.pipe(Layer.provide(sqliteLayer(database.path))),
                fakeAnswerLayer(0),
                Layer.succeed(ReplyConfiguration, { ...defaultReplySettings, attachmentMillis: 60000 })
              )
            ),
            Layer.provide(clock)
          )
          yield* Effect.gen(function* () {
            const conversation = yield* Conversation
            const old = yield* conversation.registerReplyDelivery({ completionMillis: 60000 })
            const sending = yield* conversation
              .send({ deliveryId: crypto.randomUUID(), text: "old prepared reply" })
              .pipe(Effect.forkChild)
            yield* Deferred.await(entered)
            blocking = false
            yield* conversation.unregisterReplyDelivery(old.registrationId)
            const current = yield* conversation.registerReplyDelivery({ completionMillis: 60000 })
            const input = yield* conversation.send({ deliveryId: crypto.randomUUID(), text: "new registration" })
            const ticket = yield* conversation.deliverySnapshot(current.registrationId)
            if (ticket === null) throw new Error("Current registration did not receive its own ticket")
            const authorization = conversation.replyDeliveryAuthorization(ticket)
            expect(authorization.isAuthorized()).toBe(true)
            yield* Deferred.succeed(release, undefined)
            const first = yield* Fiber.join(sending)
            expect((yield* conversation.reply(first.deliveryId)).state).toBe("Interrupted")
            expect(ticket.inputDeliveryId).toBe(input.deliveryId)
            expect(yield* conversation.deliverySnapshot(old.registrationId)).toBeNull()
            expect(yield* old.updates.pipe(Stream.runCollect)).toEqual([])
            expect(authorization.isAuthorized()).toBe(true)
            expect(authorization.signal.aborted).toBe(false)
            yield* conversation.unregisterReplyDelivery(current.registrationId)
          }).pipe(Effect.provide(application), Effect.ensuring(Deferred.succeed(release, undefined)))
        })
      )
    )
  } finally {
    await database.close()
  }
})
