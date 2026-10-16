import { Clock, Deferred, Effect, Fiber, Layer } from "effect"
import { expect, it } from "vitest"
import {
  Conversation,
  ReplyConfiguration,
  defaultReplySettings,
  StorageUnavailable
} from "../src/conversation/index.ts"
import { Memory, uniiLayer, sqliteLayer } from "../src/memory/index.ts"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { waitForReply } from "./reply-fixture.ts"
import { temporaryDatabase } from "./memory-fixture.ts"

for (const failure of ["lookup", "receipt"] as const) {
  it(`retains the exact operation after ${failure} uncertainty and retries without duplicate durable input`, async () => {
    const database = await temporaryDatabase()
    let failing = true
    const message = { deliveryId: crypto.randomUUID(), text: "uncertain acceptance" }
    try {
      const controlledMemory = Layer.effect(
        Memory,
        Effect.gen(function* () {
          const real = yield* Memory
          return Memory.of({
            ...real,
            find: (id) =>
              failing && failure === "lookup" && id === message.deliveryId
                ? Effect.fail(new StorageUnavailable({ message: "controlled unavailable lookup" }))
                : real.find(id),
            append: (payload) =>
              real
                .append(payload)
                .pipe(
                  Effect.flatMap((receipt) =>
                    failing && failure === "receipt" && payload.deliveryId === message.deliveryId
                      ? Effect.fail(
                          new StorageUnavailable({ message: "controlled lost receipt after durable acceptance" })
                        )
                      : Effect.succeed(receipt)
                  )
                )
          })
        })
      ).pipe(Layer.provide(uniiLayer.pipe(Layer.provide(sqliteLayer(database.path)))))
      const application = Conversation.configuredLayer.pipe(
        Layer.provide(
          Layer.mergeAll(controlledMemory, fakeAnswerLayer(0), Layer.succeed(ReplyConfiguration, defaultReplySettings))
        )
      )
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const conversation = yield* Conversation
            const reservation = yield* conversation.registerInput({ message })
            expect((yield* conversation.submitInput(reservation).pipe(Effect.result))._tag).toBe("Failure")
            const blocked = yield* conversation
              .registerInput({ message: { deliveryId: crypto.randomUUID(), text: "new identity during outage" } })
              .pipe(Effect.result)
            expect(blocked._tag === "Failure" && blocked.failure._tag).toBe("ReplyBusy")
            const retry = yield* conversation.registerInput({ message })
            expect(retry).toEqual(reservation)
            failing = false
            const receipt = yield* conversation.submitInput(retry)
            expect(receipt.text).toBe(message.text)
            expect(yield* conversation.send(message)).toEqual(receipt)
            yield* conversation.observeReply(message.deliveryId)
            expect((yield* waitForReply(conversation, message.deliveryId)).state).toBe("Completed")
            expect((yield* conversation.page({ limit: 100 })).messages.filter((row) => row.role === "user")).toEqual([
              receipt
            ])
          })
        ).pipe(Effect.provide(application))
      )
    } finally {
      await database.close()
    }
  })
}

it("retains the exact superseded settlement after storage failure and recovers before admitting the next input", async () => {
  const database = await temporaryDatabase()
  let failing = true
  try {
    const controlledMemory = Layer.effect(
      Memory,
      Effect.gen(function* () {
        const real = yield* Memory
        return Memory.of({
          ...real,
          append: (payload) =>
            failing && payload.role === "assistant"
              ? Effect.fail(new StorageUnavailable({ message: "controlled terminal write failure" }))
              : real.append(payload)
        })
      })
    ).pipe(Layer.provide(uniiLayer.pipe(Layer.provide(sqliteLayer(database.path)))))
    const application = Conversation.configuredLayer.pipe(
      Layer.provide(
        Layer.mergeAll(controlledMemory, fakeAnswerLayer(0), Layer.succeed(ReplyConfiguration, defaultReplySettings))
      )
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          const source = yield* conversation.openInputSource()
          const message = { deliveryId: crypto.randomUUID(), text: "superseded input" }
          const reservation = yield* conversation.registerInput({
            message,
            source: { capability: source, sequence: 0 }
          })
          yield* conversation.fenceSpeech({ capability: source, sequence: 1, fenceId: crypto.randomUUID() })
          expect((yield* conversation.submitInput(reservation).pipe(Effect.result))._tag).toBe("Failure")
          expect((yield* conversation.page({ limit: 100 })).messages.map((row) => row.role)).toEqual(["user"])
          failing = false
          const receipt = yield* conversation.submitInput(reservation)
          expect(receipt.text).toBe(message.text)
          expect((yield* conversation.reply(message.deliveryId)).state).toBe("Interrupted")
          yield* conversation.send({ deliveryId: crypto.randomUUID(), text: "fresh input" })
          expect((yield* conversation.page({ limit: 100 })).messages.slice(0, 3).map((row) => row.role)).toEqual([
            "user",
            "assistant",
            "user"
          ])
        })
      ).pipe(Effect.provide(application))
    )
  } finally {
    await database.close()
  }
})

it("settles a failed start after authorization is revoked during asynchronous delivery preparation", async () => {
  const database = await temporaryDatabase()
  let failing = true
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const nativeClock = yield* Clock.Clock
          const controlledClock = Layer.succeed(Clock.Clock, {
            currentTimeMillisUnsafe: () => nativeClock.currentTimeMillisUnsafe(),
            currentTimeNanosUnsafe: () => nativeClock.currentTimeNanosUnsafe(),
            currentTimeNanos: nativeClock.currentTimeNanos,
            monotonicTimeNanosUnsafe: () => nativeClock.monotonicTimeNanosUnsafe(),
            monotonicTimeNanos: nativeClock.monotonicTimeNanos,
            sleep: (duration) => nativeClock.sleep(duration),
            currentTimeMillis: Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(nativeClock.currentTimeMillis)
            )
          })
          const controlledMemory = Layer.effect(
            Memory,
            Effect.gen(function* () {
              const real = yield* Memory
              return Memory.of({
                ...real,
                append: (payload) =>
                  failing && payload.role === "assistant"
                    ? Effect.fail(new StorageUnavailable({ message: "controlled interrupted start storage failure" }))
                    : real.append(payload)
              })
            })
          ).pipe(Layer.provide(uniiLayer.pipe(Layer.provide(sqliteLayer(database.path)))))
          const application = Conversation.configuredLayer.pipe(
            Layer.provide(
              Layer.mergeAll(
                controlledMemory,
                fakeAnswerLayer(0),
                Layer.succeed(ReplyConfiguration, defaultReplySettings)
              )
            ),
            Layer.provide(controlledClock)
          )
          yield* Effect.gen(function* () {
            const conversation = yield* Conversation
            const scope = yield* Effect.scope
            const source = yield* conversation.openInputSource()
            yield* conversation.registerReplyDelivery({
              completionMillis: 60000,
              started: () => {},
              invalidated: () => {}
            })
            const message = { deliveryId: crypto.randomUUID(), text: "fenced during preparation" }
            const reservation = yield* conversation.registerInput({
              message,
              source: { capability: source, sequence: 0 }
            })
            const pending = yield* conversation.submitInput(reservation).pipe(Effect.result, Effect.forkIn(scope))
            yield* Deferred.await(entered).pipe(Effect.timeout("2 seconds"))
            yield* conversation.fenceSpeech({ capability: source, sequence: 1, fenceId: crypto.randomUUID() })
            yield* Deferred.succeed(release, undefined)
            expect((yield* Fiber.join(pending))._tag).toBe("Failure")
            failing = false
            const receipt = yield* conversation.submitInput(reservation)
            expect(receipt.text).toBe(message.text)
            const reply = yield* conversation.reply(message.deliveryId)
            expect(reply.state).toBe("Interrupted")
            expect(reply.text).toBe("")
            expect((yield* conversation.page({ limit: 100 })).messages.map((row) => row.role)).toEqual([
              "user",
              "assistant"
            ])
          }).pipe(Effect.provide(application))
        })
      )
    )
  } finally {
    await database.close()
  }
})
