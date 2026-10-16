import type { Storage } from "@firfi/unii"
import { Effect } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import { waitForReply } from "./reply-fixture.ts"
import { SqliteStorage } from "../src/memory/sqlite.ts"
import { decoratedConversation, temporaryDatabase } from "./memory-fixture.ts"

const first = { deliveryId: "11111111-1111-4111-8111-111111111111", text: "first" }
const second = { deliveryId: "22222222-2222-4222-8222-222222222222", text: "second" }
const faultController = (stage: "raw" | "checkpoint", persistent: boolean) => {
  const state = { failing: true, opens: 0, closes: 0, loads: 0 }
  const fail = () => {
    if (!state.failing) return
    state.failing = persistent
    throw new Error("Injected durable write failure")
  }
  const decorate = (storage: Storage): Storage => ({
    open: async () => {
      state.opens++
      await storage.open()
    },
    close: async () => {
      state.closes++
      await storage.close()
    },
    load: async () => {
      state.loads++
      return storage.load()
    },
    appendRecords: async (records) => {
      if (stage === "raw") fail()
      await storage.appendRecords(records)
    },
    appendNode: (node) => storage.appendNode(node),
    checkpoint: async (value) => {
      if (stage === "checkpoint" && value.cursor > 0) fail()
      await storage.checkpoint(value)
    }
  })
  return { state, decorate }
}
const stages: readonly ("raw" | "checkpoint")[] = ["raw", "checkpoint"]
for (const stage of stages) {
  it(`recovers a one-shot ${stage} failure inside the same host without releasing its writer`, async () => {
    const fixture = await temporaryDatabase()
    const fault = faultController(stage, false)
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const conversation = yield* Conversation
            expect((yield* Effect.flip(conversation.send(first)))._tag).toBe("StorageUnavailable")
            expect((yield* conversation.send(first)).recordId).toBe(0)
            yield* conversation.cancelReply(first.deliveryId)
            expect((yield* Effect.flip(conversation.send({ ...first, text: "conflict" })))._tag).toBe(
              "DeliveryConflict"
            )
            expect(() => new SqliteStorage(fixture.path)).toThrow()
            const receipts = yield* Effect.all(
              [conversation.send(second), conversation.send(second), conversation.send(first)],
              { concurrency: "unbounded" }
            )
            expect(receipts[0]?.recordId).toBe(1)
            expect(receipts[1]).toEqual(receipts[0])
            expect(receipts[2]?.recordId).toBe(0)
            expect((yield* conversation.page({ limit: 100 })).messages).toHaveLength(2)
            expect(fault.state.opens).toBe(1)
            expect(fault.state.closes).toBe(0)
            expect(fault.state.loads).toBe(2)
            expect(() => new SqliteStorage(fixture.path)).toThrow()
          })
        ).pipe(Effect.provide(decoratedConversation(fixture.path, fault.decorate)))
      )
      expect(fault.state.closes).toBe(0)
      const reacquired = new SqliteStorage(fixture.path)
      await reacquired.close()
    } finally {
      await fixture.close()
    }
  })
}
it("bounds persistent recovery to one reopen per request and resumes after the storage repairs", async () => {
  const fixture = await temporaryDatabase()
  const fault = faultController("checkpoint", true)
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          expect((yield* Effect.flip(conversation.send(first)))._tag).toBe("StorageUnavailable")
          expect(fault.state.loads).toBe(1)
          expect((yield* conversation.send(first)).recordId).toBe(0)
          // This is the original uncertain attempt, so acceptance starts its eligible response.
          const reply = yield* waitForReply(conversation, first.deliveryId)
          expect(reply.error?.code).toBe("StorageUnavailable")
          expect(fault.state.loads).toBe(2)
          expect((yield* Effect.flip(conversation.send(second)))._tag).toBe("StorageUnavailable")
          expect(fault.state.loads).toBe(3)
          expect((yield* Effect.flip(conversation.send(second)))._tag).toBe("StorageUnavailable")
          expect(fault.state.loads).toBe(4)
          expect(() => new SqliteStorage(fixture.path)).toThrow()
          yield* Effect.sync(() => {
            fault.state.failing = false
          })
          expect((yield* conversation.send(second)).recordId).toBe(1)
          expect(fault.state.loads).toBe(5)
          expect(fault.state.opens).toBe(1)
          expect(fault.state.closes).toBe(0)
        })
      ).pipe(Effect.provide(decoratedConversation(fixture.path, fault.decorate)))
    )
    expect(fault.state.closes).toBe(0)
    const reacquired = new SqliteStorage(fixture.path)
    await reacquired.close()
  } finally {
    await fixture.close()
  }
})
