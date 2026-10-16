import { Deferred, Effect, Fiber, Layer } from "effect"
import { expect, it } from "vitest"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { Conversation, ReplyConfiguration, defaultReplySettings } from "../src/conversation/index.ts"
import { Memory, StorageUnavailable, sqliteLayer, uniiLayer, type DeliveryPayload } from "../src/memory/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"

const makeFault = (path: string, blocking: boolean) =>
  Effect.gen(function* () {
    const writing = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let failing = true
    let attempts: readonly DeliveryPayload[] = []
    const memory = Layer.effect(
      Memory,
      Effect.gen(function* () {
        const real = yield* Memory
        return Memory.of({
          ...real,
          append: (payload) =>
            payload.role !== "assistant"
              ? real.append(payload)
              : Effect.suspend(() => {
                  attempts = [...attempts, structuredClone(payload)]
                  return Deferred.succeed(writing, undefined).pipe(
                    Effect.andThen(blocking ? Deferred.await(release) : Effect.void),
                    Effect.andThen(
                      Effect.suspend(() =>
                        failing
                          ? Effect.fail(new StorageUnavailable({ message: "Fixture terminal write failed" }))
                          : real.append(payload)
                      )
                    )
                  )
                })
        })
      })
    ).pipe(Layer.provide(uniiLayer.pipe(Layer.provide(sqliteLayer(path)))))
    return {
      writing,
      release,
      attempts: () => attempts,
      repair: () => {
        failing = false
      },
      layer: Conversation.configuredLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            memory,
            fakeAnswerLayer(0),
            Layer.succeed(ReplyConfiguration, { ...defaultReplySettings, attachmentMillis: 60000 })
          )
        )
      )
    }
  })
type Fault = Effect.Success<ReturnType<typeof makeFault>>
const withFault = async (blocking: boolean, use: (fault: Fault) => Effect.Effect<void, unknown, Conversation>) => {
  const database = await temporaryDatabase()
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fault = yield* makeFault(database.path, blocking)
        yield* use(fault).pipe(
          Effect.ensuring(Deferred.succeed(fault.release, undefined)),
          Effect.scoped,
          Effect.provide(fault.layer)
        )
      })
    )
  } finally {
    await database.close()
  }
}
const awaitState = (conversation: Conversation["Service"], id: string, state: "Delivering" | "Failed") =>
  Effect.gen(function* () {
    let reply = yield* conversation.reply(id)
    for (let poll = 0; reply.state !== state && poll < 300; poll++) {
      yield* Effect.sleep(5)
      reply = yield* conversation.reply(id)
    }
    expect(reply.state).toBe(state)
    return reply
  })

it("retires delivery after an already failed completion without losing its exact retry intent", () =>
  withFault(false, (fault) =>
    Effect.gen(function* () {
      const conversation = yield* Conversation
      const registration = yield* conversation.registerReplyDelivery({ completionMillis: 60000 })
      const input = yield* conversation.send({ deliveryId: crypto.randomUUID(), text: "delivery cleanup" })
      yield* awaitState(conversation, input.deliveryId, "Delivering")
      const ticket = yield* conversation.deliverySnapshot(registration.registrationId)
      if (ticket === null) throw new Error("Missing delivery ticket")
      const failed = yield* conversation.settleReplyDelivery({ ...ticket, outcome: "Completed" }).pipe(Effect.result)
      expect(failed._tag).toBe("Failure")
      const cleanup = yield* conversation
        .unregisterReplyDelivery(registration.registrationId)
        .pipe(Effect.result, Effect.timeout("2 seconds"))
      expect(cleanup._tag).toBe("Failure")
      if (cleanup._tag === "Failure") expect(cleanup.failure._tag).toBe("StorageUnavailable")
      expect(yield* conversation.deliverySnapshot(registration.registrationId)).toBeNull()
      expect(fault.attempts()).toHaveLength(1)
      const replacement = yield* conversation.registerReplyDelivery({ completionMillis: 60000 })
      yield* conversation.unregisterReplyDelivery(replacement.registrationId)
      fault.repair()
      const recovered = yield* conversation.interruptResponse(ticket)
      expect(recovered?.state).toBe("Completed")
      expect(fault.attempts()).toEqual([fault.attempts()[0], fault.attempts()[0]])
      expect((yield* conversation.page({ limit: 100 })).messages).toEqual([input, recovered?.receipt])
    })
  ))
it("finishes text observer cleanup after failed persistence without another write", () =>
  withFault(false, (fault) =>
    Effect.gen(function* () {
      const conversation = yield* Conversation
      const input = yield* conversation.send({ deliveryId: crypto.randomUUID(), text: "observer cleanup" })
      const failed = yield* awaitState(conversation, input.deliveryId, "Failed")
      expect(failed.error?.code).toBe("StorageUnavailable")
      const observer = yield* conversation.observeReply(input.deliveryId)
      yield* conversation.cancelReply(input.deliveryId).pipe(Effect.timeout("2 seconds"))
      yield* conversation.releaseReply(input.deliveryId, observer).pipe(Effect.timeout("2 seconds"))
      expect(fault.attempts()).toHaveLength(1)
      expect(yield* conversation.reply(input.deliveryId)).toEqual(failed)
      fault.repair()
      expect((yield* conversation.interruptResponse(failed))?.state).toBe("Completed")
    })
  ))
it("keeps cancellation infallible when the joined terminal write fails", () =>
  withFault(true, (fault) =>
    Effect.gen(function* () {
      const conversation = yield* Conversation
      const input = yield* conversation.send({ deliveryId: crypto.randomUUID(), text: "cleanup during write" })
      yield* Deferred.await(fault.writing).pipe(Effect.timeout("2 seconds"))
      const cancellation = yield* conversation.cancelReply(input.deliveryId).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* conversation.observeReply(input.deliveryId)
      yield* Deferred.succeed(fault.release, undefined)
      yield* Fiber.join(cancellation).pipe(Effect.timeout("2 seconds"))
      expect((yield* awaitState(conversation, input.deliveryId, "Failed")).error?.code).toBe("StorageUnavailable")
      expect(fault.attempts()).toHaveLength(1)
      expect((yield* conversation.page({ limit: 100 })).messages).toEqual([input])
    })
  ))
