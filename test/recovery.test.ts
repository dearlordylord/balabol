import type { Storage } from "@firfi/unii"
import { Effect, Schema } from "effect"
import { expect, it } from "vitest"
import { Conversation, SendMessage } from "../src/conversation/index.ts"
import { conversationLayer } from "../src/bootstrap/index.ts"
import { decoratedConversation, temporaryDatabase } from "./memory-fixture.ts"

const first = Schema.decodeUnknownSync(SendMessage)({
  deliveryId: "11111111-1111-4111-8111-111111111111",
  text: "hello"
})
const second = Schema.decodeUnknownSync(SendMessage)({
  deliveryId: "22222222-2222-4222-8222-222222222222",
  text: "next"
})
const failCheckpoint = (storage: Storage): Storage => ({
  open: () => storage.open(),
  load: () => storage.load(),
  appendRecords: (records) => storage.appendRecords(records),
  appendNode: (node) => storage.appendNode(node),
  close: () => storage.close(),
  checkpoint: async (checkpoint) => {
    if (checkpoint.cursor > 0) throw new Error("Injected checkpoint write failure")
    await storage.checkpoint(checkpoint)
  }
})
it("preserves durable raw acceptance after checkpoint failure; retry never duplicates; reopen recovers", async () => {
  const fixture = await temporaryDatabase()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          expect((yield* Effect.flip(conversation.send(first)))._tag).toBe("StorageUnavailable")
          expect((yield* conversation.send(first)).recordId).toBe(0)
          expect((yield* Effect.flip(conversation.send({ ...first, text: "conflict" })))._tag).toBe("DeliveryConflict")
          expect((yield* Effect.flip(conversation.send(second)))._tag).toBe("StorageUnavailable")
          expect((yield* conversation.page({ limit: 100 })).messages).toHaveLength(1)
        })
      ).pipe(Effect.provide(decoratedConversation(fixture.path, failCheckpoint)))
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          expect((yield* conversation.send(first)).recordId).toBe(0)
          expect((yield* conversation.send(second)).recordId).toBe(1)
          expect((yield* conversation.page({ limit: 100 })).messages).toHaveLength(2)
        })
      ).pipe(Effect.provide(conversationLayer(fixture.path)))
    )
  } finally {
    await fixture.close()
  }
})
it("serializes concurrent duplicate requests and paginates ledger order across split raw records", async () => {
  const fixture = await temporaryDatabase()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          const long = { ...first, text: "é".repeat(30_001) }
          const receipts = yield* Effect.all([conversation.send(long), conversation.send(long)], {
            concurrency: "unbounded"
          })
          expect(receipts[0]).toEqual(receipts[1])
          yield* conversation.cancelReply(first.deliveryId)
          const later = yield* conversation.send(second)
          expect(later.recordId).toBe(3)
          expect(later.position).toBe(1)
          const page = yield* conversation.page({ limit: 1 })
          expect(page.messages[0]?.text).toBe(long.text)
          expect(page.nextAfter).toBe(0)
          expect((yield* conversation.page({ after: 0, limit: 100 })).messages).toEqual([later])
          expect((yield* conversation.page({ after: 1, limit: 100 })).nextAfter).toBeNull()
        })
      ).pipe(Effect.provide(conversationLayer(fixture.path)))
    )
  } finally {
    await fixture.close()
  }
})

it("rejects corrupted durable delivery evidence instead of acknowledging invalid receipts", async () => {
  const fixture = await temporaryDatabase()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          yield* conversation.send(first)
        })
      ).pipe(Effect.provide(conversationLayer(fixture.path)))
    )
    const { DatabaseSync } = await import("node:sqlite")
    const database = new DatabaseSync(fixture.path)
    database.prepare("UPDATE deliveries SET firstId=-1 WHERE deliveryId=?").run(first.deliveryId)
    database.close()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          expect((yield* Effect.flip(conversation.send(first)))._tag).toBe("StorageUnavailable")
          expect((yield* Effect.flip(conversation.page({ limit: 100 })))._tag).toBe("StorageUnavailable")
        })
      ).pipe(Effect.provide(conversationLayer(fixture.path)))
    )
  } finally {
    await fixture.close()
  }
})

it("allocates positions at durable acceptance, not an abandoned intent", async () => {
  const fixture = await temporaryDatabase()
  const failRaw = (storage: Storage): Storage => ({
    ...failCheckpoint(storage),
    checkpoint: (value) => storage.checkpoint(value),
    appendRecords: async () => {
      throw new Error("Injected raw write failure")
    }
  })
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          expect((yield* Effect.flip(conversation.send(first)))._tag).toBe("StorageUnavailable")
        })
      ).pipe(Effect.provide(decoratedConversation(fixture.path, failRaw)))
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          expect((yield* conversation.send(second)).position).toBe(0)
          yield* conversation.cancelReply(second.deliveryId)
          expect((yield* conversation.send(first)).position).toBe(1)
          expect((yield* conversation.page({ after: 0, limit: 100 })).messages[0]?.deliveryId).toBe(first.deliveryId)
        })
      ).pipe(Effect.provide(conversationLayer(fixture.path)))
    )
  } finally {
    await fixture.close()
  }
})
