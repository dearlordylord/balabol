import { Effect, Layer } from "effect"
import { expect, it } from "vitest"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { SqliteStorage } from "../src/memory/sqlite.ts"
import { Conversation } from "../src/conversation/index.ts"
import { configurableFakeSummaryLayer, SummaryGeneration } from "../src/summary-generation/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { replyLayer, waitForReply } from "./reply-fixture.ts"

it("retries failed prior memory without duplicate input and restores a bounded current turn", async () => {
  const fixture = await temporaryDatabase()
  const first = { deliveryId: "11111111-1111-4111-8111-111111111111", text: "long prior input ".repeat(100) }
  const second = { deliveryId: "22222222-2222-4222-8222-222222222222", text: "follow-up" }
  const layer = replyLayer(
    fixture.path,
    fakeAnswerLayer(0),
    { contextWaitAttempts: 100 },
    configurableFakeSummaryLayer({ failFirstJob: true, delayMillis: 100, invalidCompletion: false })
  )
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          expect(yield* conversation.currentTurn()).toBeNull()
          yield* conversation.send(first)
          expect((yield* waitForReply(conversation, first.deliveryId)).state).toBe("Completed")
          yield* conversation.send(second)
          const failed = yield* waitForReply(conversation, second.deliveryId)
          expect(failed.error?.code).toBe("MemoryFailed")
          expect((yield* conversation.currentTurn())?.reply).toEqual(failed)
          const retry = yield* conversation.retryReply(second.deliveryId)
          expect(retry.responseId).not.toBe(failed.responseId)
          expect((yield* conversation.retryReply(second.deliveryId)).responseId).toBe(retry.responseId)
          const completed = yield* waitForReply(conversation, second.deliveryId)
          expect(completed.state).toBe("Completed")
          expect(completed.text).toMatch(/Prior memory: [1-9][0-9]* characters available/)
          expect((yield* conversation.retryReply(second.deliveryId)).responseId).toBe(retry.responseId)
          expect((yield* Effect.result(conversation.retryReply(first.deliveryId)))._tag).toBe("Failure")
          expect((yield* Effect.result(conversation.page({ limit: -1 })))._tag).toBe("Failure")
          const page = yield* conversation.page({ limit: 100 })
          expect(page.messages.filter((message) => message.role === "user")).toHaveLength(2)
          expect(page.messages).toHaveLength(4)
        })
      ).pipe(Effect.provide(layer))
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          const current = yield* conversation.currentTurn()
          expect(current?.input.deliveryId).toBe(second.deliveryId)
          expect(current?.reply.state).toBe("Completed")
        })
      ).pipe(Effect.provide(replyLayer(fixture.path, fakeAnswerLayer(0))))
    )
  } finally {
    await fixture.close()
  }
})

it("settles a durable prepared completion after restart before attempting any replacement response", async () => {
  const fixture = await temporaryDatabase()
  const input = { deliveryId: "33333333-3333-4333-8333-333333333333", text: "recover completion" }
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          yield* conversation.send(input)
          yield* conversation.cancelReply(input.deliveryId)
        })
      ).pipe(Effect.provide(replyLayer(fixture.path, fakeAnswerLayer(100))))
    )
    const storage = new SqliteStorage(fixture.path)
    storage.prepare({
      deliveryId: "44444444-4444-4444-8444-444444444444",
      inputDeliveryId: input.deliveryId,
      responseId: "44444444-4444-4444-8444-444444444444",
      text: "prepared complete reply",
      role: "assistant",
      outcome: "completed"
    })
    await storage.close()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          expect((yield* conversation.currentTurn())?.reply.error?.code).toBe("Restarted")
          const retry = yield* conversation.retryReply(input.deliveryId)
          expect(retry.state).toBe("Completed")
          expect(retry.text).toBe("prepared complete reply")
          expect((yield* conversation.page({ limit: 100 })).messages).toHaveLength(2)
        })
      ).pipe(Effect.provide(replyLayer(fixture.path, fakeAnswerLayer(0))))
    )
  } finally {
    await fixture.close()
  }
})

it("cancels active summary work at host shutdown and rejects a late provider completion after releasing its writer", async () => {
  const fixture = await temporaryDatabase()
  let started = false
  let cancelled = false
  let complete: (text: string) => void = () => {
    throw new Error("Summary has not started")
  }
  const late = new Promise<string>((resolve) => {
    complete = resolve
  })
  const summary = Layer.succeed(SummaryGeneration, {
    summarize: () =>
      Effect.sync(() => {
        started = true
      }).pipe(
        Effect.andThen(Effect.promise(() => late)),
        Effect.ensuring(
          Effect.sync(() => {
            cancelled = true
          })
        )
      )
  })
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          yield* conversation.send({
            deliveryId: "55555555-5555-4555-8555-555555555555",
            text: "shutdown source ".repeat(120)
          })
          yield* conversation.cancelReply("55555555-5555-4555-8555-555555555555")
          yield* Effect.sleep(30)
          expect(started).toBe(true)
          expect(cancelled).toBe(false)
        })
      ).pipe(Effect.provide(replyLayer(fixture.path, fakeAnswerLayer(100), {}, summary)))
    )
    expect(cancelled).toBe(true)
    const storage = new SqliteStorage(fixture.path)
    try {
      const before = await storage.load()
      complete("late completed summary")
      await Effect.runPromise(Effect.sleep(30))
      expect(await storage.load()).toEqual(before)
      expect(before.nodes).toHaveLength(0)
      expect(storage.page(undefined, 100)).toHaveLength(1)
      for (const limit of [-1, 0, 1.5, 101]) expect(() => storage.page(undefined, limit)).toThrow()
      expect(() => storage.page(-1, 1)).toThrow()
    } finally {
      await storage.close()
    }
  } finally {
    await fixture.close()
  }
})
