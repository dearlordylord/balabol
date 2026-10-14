import type { Storage } from "@firfi/unii"
import { Effect, Layer, Fiber, Stream } from "effect"
import { expect, it } from "vitest"
import { fakeAnswerLayer, AnswerGeneration } from "../src/answer-generation/index.ts"
import { Conversation, defaultReplySettings, ReplyConfiguration } from "../src/conversation/index.ts"
import { Memory, DurableMemory, sqliteLayer, uniiLayer } from "../src/memory/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { waitForReply } from "./reply-fixture.ts"

const first = { deliveryId: "11111111-1111-4111-8111-111111111111", text: "Hello" }
const second = { deliveryId: "22222222-2222-4222-8222-222222222222", text: "Next" }
const failingLayer = (path: string, fault: { failing: boolean }) => {
  const decorate = (storage: Storage): Storage => ({
    ...storage,
    open: () => storage.open(),
    close: () => storage.close(),
    load: () => storage.load(),
    appendNode: (node) => storage.appendNode(node),
    checkpoint: (checkpoint) => storage.checkpoint(checkpoint),
    appendRecords: async (records) => {
      if (fault.failing) throw new Error("Injected pre-write fault")
      await storage.appendRecords(records)
    }
  })
  const durable = Layer.effect(
    DurableMemory,
    Effect.gen(function* () {
      const adapter = yield* DurableMemory
      return { ...adapter, storage: decorate(adapter.storage) }
    })
  ).pipe(Layer.provide(sqliteLayer(path)))
  return Conversation.configuredLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        fakeAnswerLayer(0),
        Layer.succeed(ReplyConfiguration, { ...defaultReplySettings, attachmentMillis: 60000 }),
        uniiLayer.pipe(Layer.provide(durable))
      )
    )
  )
}
it("recovers a completed delivery after a pre-write failure before admitting another input", async () => {
  const database = await temporaryDatabase()
  const fault = { failing: false }
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          const registration = yield* conversation.registerReplyDelivery({
            completionMillis: 60000,
            started: () => undefined,
            invalidated: () => undefined
          })
          yield* conversation.send(first)
          expect((yield* waitForReply(conversation, first.deliveryId)).state).toBe("Delivering")
          const ticket = yield* conversation.deliverySnapshot(registration.registrationId)
          if (ticket === null) throw new Error("Missing delivery")
          fault.failing = true
          expect(
            (yield* conversation.settleReplyDelivery({ ...ticket, outcome: "Completed" }).pipe(Effect.result))._tag
          ).toBe("Failure")
          expect((yield* conversation.reply(first.deliveryId)).state).toBe("Failed")
          fault.failing = false
          yield* conversation.send(second)
          const prior = yield* conversation.reply(first.deliveryId)
          expect(prior.state).toBe("Completed")
          expect(prior.receipt?.outcome).toBe("completed")
          expect((yield* conversation.page({ limit: 100 })).messages.map((message) => message.role)).toEqual([
            "user",
            "assistant",
            "user"
          ])
        })
      ).pipe(Effect.provide(failingLayer(database.path, fault)))
    )
  } finally {
    await database.close()
  }
})

it("detaches failed unregister and recovers the exact interrupted reply before the next input", async () => {
  const database = await temporaryDatabase()
  const fault = { failing: false }
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          let invalidated = false
          const registration = yield* conversation.registerReplyDelivery({
            completionMillis: 60000,
            started: () => undefined,
            invalidated: () => {
              invalidated = true
            }
          })
          yield* conversation.send(first)
          const generated = yield* waitForReply(conversation, first.deliveryId)
          fault.failing = true
          expect(
            (yield* conversation.unregisterReplyDelivery(registration.registrationId).pipe(Effect.result))._tag
          ).toBe("Failure")
          expect(invalidated).toBe(true)
          expect(yield* conversation.deliverySnapshot(registration.registrationId)).toBeNull()
          const replacement = yield* conversation.registerReplyDelivery({
            completionMillis: 60000,
            started: () => undefined,
            invalidated: () => undefined
          })
          expect(replacement.registrationId).not.toBe(registration.registrationId)
          fault.failing = false
          yield* conversation.send(second)
          const recovered = yield* conversation.reply(first.deliveryId)
          expect(recovered.state).toBe("Interrupted")
          expect(recovered.text).toBe(generated.text)
          expect(recovered.receipt?.outcome).toBe("interrupted")
        })
      ).pipe(Effect.provide(failingLayer(database.path, fault)))
    )
  } finally {
    await database.close()
  }
})

it("freezes the response before pending-memory reads even when provider completes and SSE disconnects", async () => {
  const database = await temporaryDatabase()
  let releaseProvider: () => void = () => undefined
  let releasePending: () => void = () => undefined
  let pendingEntered: () => void = () => undefined
  const providerGate = new Promise<void>((resolve) => {
    releaseProvider = resolve
  })
  const pendingGate = new Promise<void>((resolve) => {
    releasePending = resolve
  })
  const entered = new Promise<void>((resolve) => {
    pendingEntered = resolve
  })
  let blocked = false
  const memory = Layer.effect(
    Memory,
    Effect.gen(function* () {
      const real = yield* Memory
      return Memory.of({
        ...real,
        pendingReply: () =>
          blocked
            ? Effect.promise(() => {
                pendingEntered()
                return pendingGate
              }).pipe(Effect.andThen(real.pendingReply()))
            : real.pendingReply()
      })
    })
  ).pipe(Layer.provide(uniiLayer.pipe(Layer.provide(sqliteLayer(database.path)))))
  const answer = Layer.succeed(
    AnswerGeneration,
    AnswerGeneration.of({
      capabilities: { languages: ["ru", "fr", "en"], output: "text-deltas" },
      generate: () =>
        Stream.concat(
          Stream.succeed({ kind: "Delta", text: "retained partial", languageSpans: [] }),
          Stream.fromEffect(Effect.promise(() => providerGate).pipe(Effect.as({ kind: "Completed" })))
        )
    })
  )
  const layer = Conversation.configuredLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        memory,
        answer,
        Layer.succeed(ReplyConfiguration, { ...defaultReplySettings, attachmentMillis: 60000 })
      )
    )
  )
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          yield* conversation.send(first)
          const token = yield* conversation.observeReply(first.deliveryId)
          yield* Effect.sleep(10)
          blocked = true
          const sending = yield* Effect.forkChild(conversation.send(second))
          yield* Effect.promise(() => entered)
          releaseProvider()
          const release = yield* Effect.forkChild(conversation.releaseReply(first.deliveryId, token))
          const cancel = yield* Effect.forkChild(conversation.cancelReply(first.deliveryId))
          yield* Effect.sleep(10)
          expect((yield* conversation.reply(first.deliveryId)).state).toBe("Streaming")
          releasePending()
          yield* Fiber.join(sending)
          yield* Fiber.join(release)
          yield* Fiber.join(cancel)
          const interrupted = yield* conversation.reply(first.deliveryId)
          expect(interrupted.state).toBe("Interrupted")
          expect(interrupted.text).toBe("retained partial")
          expect(interrupted.receipt?.outcome).toBe("interrupted")
        })
      ).pipe(Effect.provide(layer))
    )
  } finally {
    releasePending()
    releaseProvider()
    await database.close()
  }
})

it("invalidates queued delivery on provider terminal failure and rejects late completion", async () => {
  const database = await temporaryDatabase()
  const answer = Layer.succeed(
    AnswerGeneration,
    AnswerGeneration.of({
      capabilities: { languages: ["ru", "fr", "en"], output: "text-deltas" },
      generate: () =>
        Stream.fromIterable([
          { kind: "Delta", text: "partial", languageSpans: [] },
          { kind: "Completed" },
          { kind: "Delta", text: "late", languageSpans: [] }
        ])
    })
  )
  const layer = Conversation.configuredLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        answer,
        Layer.succeed(ReplyConfiguration, { ...defaultReplySettings, attachmentMillis: 60000 }),
        uniiLayer.pipe(Layer.provide(sqliteLayer(database.path)))
      )
    )
  )
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          let invalidated = false
          const registration = yield* conversation.registerReplyDelivery({
            completionMillis: 60000,
            started: () => undefined,
            invalidated: () => {
              invalidated = true
            }
          })
          yield* conversation.send(first)
          const failed = yield* waitForReply(conversation, first.deliveryId)
          expect(failed.state).toBe("Failed")
          expect(failed.error?.code).toBe("ProviderFailed")
          expect(invalidated).toBe(true)
          expect(yield* conversation.deliverySnapshot(registration.registrationId)).toBeNull()
        })
      ).pipe(Effect.provide(layer))
    )
  } finally {
    await database.close()
  }
})
