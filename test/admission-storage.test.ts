import { Deferred, Effect, Fiber, Layer } from "effect"
import { expect, it } from "vitest"
import {
  Conversation,
  ReplyConfiguration,
  defaultReplySettings,
  StorageUnavailable
} from "../src/conversation/index.ts"
import { Memory, uniiLayer, sqliteLayer } from "../src/memory/index.ts"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { waitForReply } from "./reply-fixture.ts"

it("processes a speech fence while real durable admission is waiting and subsequently admits fresh input", async () => {
  const database = await temporaryDatabase()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const message = { deliveryId: crypto.randomUUID(), text: "delayed input" }
          const controlledMemory = Layer.effect(
            Memory,
            Effect.gen(function* () {
              const real = yield* Memory
              return Memory.of({
                ...real,
                append: (payload) =>
                  payload.deliveryId === message.deliveryId
                    ? Deferred.succeed(entered, undefined).pipe(
                        Effect.andThen(Deferred.await(release)),
                        Effect.andThen(real.append(payload))
                      )
                    : real.append(payload)
              })
            })
          ).pipe(Layer.provide(uniiLayer.pipe(Layer.provide(sqliteLayer(database.path)))))
          const application = Conversation.configuredLayer.pipe(
            Layer.provide(
              Layer.mergeAll(
                controlledMemory,
                fakeAnswerLayer(0),
                Layer.succeed(ReplyConfiguration, { ...defaultReplySettings, attachmentMillis: 60000 })
              )
            )
          )
          yield* Effect.gen(function* () {
            const conversation = yield* Conversation
            const scope = yield* Effect.scope
            const source = yield* conversation.openInputSource()
            yield* conversation.fenceSpeech({ capability: source, sequence: 1, fenceId: crypto.randomUUID() })
            const intent = yield* conversation.registerInput({ message, source: { capability: source, sequence: 1 } })
            const submitting = yield* conversation.submitInput(intent).pipe(Effect.forkIn(scope))
            yield* Deferred.await(entered).pipe(Effect.timeout("2 seconds"))
            const fence = { capability: source, sequence: 2, fenceId: crypto.randomUUID() }
            const acknowledgement = yield* conversation.fenceSpeech(fence).pipe(Effect.timeout("2 seconds"))
            expect(yield* conversation.fenceSpeech(fence)).toEqual(acknowledgement)
            yield* conversation.closeInputSource(source)
            expect((yield* conversation.fenceSpeech(fence).pipe(Effect.result))._tag).toBe("Failure")
            yield* Deferred.succeed(release, undefined)
            const receipt = yield* Fiber.join(submitting)
            expect((yield* conversation.page({ limit: 100 })).messages.filter((row) => row.role === "user")).toEqual([
              receipt
            ])
            expect((yield* conversation.reply(receipt.deliveryId)).state).toBe("Interrupted")
            const fresh = yield* conversation.send({ deliveryId: crypto.randomUUID(), text: "fresh input" })
            yield* conversation.observeReply(fresh.deliveryId)
            expect((yield* waitForReply(conversation, fresh.deliveryId)).state).toBe("Completed")
            expect(yield* conversation.send(message)).toEqual(receipt)
            expect((yield* conversation.page({ limit: 100 })).messages.map((row) => row.role)).toEqual([
              "user",
              "assistant",
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

it("reports unavailable admission and permits a retry through the same durable delivery identity", async () => {
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
            failing
              ? Effect.fail(new StorageUnavailable({ message: "controlled admission failure" }))
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
          const message = { deliveryId: crypto.randomUUID(), text: "retry admission" }
          expect((yield* conversation.send(message).pipe(Effect.result))._tag).toBe("Failure")
          expect((yield* conversation.page({ limit: 100 })).messages).toEqual([])
          failing = false
          const receipt = yield* conversation.send(message)
          expect(yield* conversation.send(message)).toEqual(receipt)
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
