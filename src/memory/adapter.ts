import type { Storage } from "@firfi/unii"
import { Context, Effect, Layer, Schema } from "effect"
import type { DeliveryPayload, Receipt } from "./contracts.ts"
import { DeliveryEvidence, WriterUnavailable } from "./contracts.ts"
import { SqliteStorage } from "./sqlite.ts"

// Injected durable adapter. prepare binds the next raw batch; the caller serializes prepare/append.
// Its scoped lease and Storage persistence boundary follow the inspected unii contract.
export class DurableMemory extends Context.Service<
  DurableMemory,
  {
    storage: Storage
    findReply: (inputDeliveryId: string) => Receipt | undefined
    prepare: (payload: DeliveryPayload) => void
    find: (deliveryId: DeliveryPayload["deliveryId"]) => DeliveryEvidence | undefined
    page: (after: number | undefined, limit: number) => readonly Receipt[]
  }
>()("balabol/memory/durable") {}

export const sqliteLayer = (path: string) =>
  Layer.effect(
    DurableMemory,
    Effect.gen(function* () {
      const storage = yield* Effect.acquireRelease(
        Effect.try({
          try: () => new SqliteStorage(path),
          catch: () => new WriterUnavailable({ message: "Cannot acquire durable memory writer" })
        }),
        (instance) => Effect.promise(() => instance.close())
      )
      return DurableMemory.of({
        storage,
        findReply: (id) => storage.findReply(id),
        find: (id) => {
          const row = storage.find(id)
          if (row === undefined) return undefined
          const payload = {
            deliveryId: row.deliveryId,
            text: row.text,
            role: row.role,
            ...(row.inputDeliveryId === null ? {} : { inputDeliveryId: row.inputDeliveryId }),
            ...(row.responseId === null ? {} : { responseId: row.responseId })
          }
          return Schema.decodeUnknownSync(DeliveryEvidence)(
            row.firstId === null
              ? { state: "Intent", payload }
              : { state: "Accepted", receipt: { ...payload, recordId: row.firstId, position: row.position } }
          )
        },
        page: (after, limit) => storage.page(after, limit),
        prepare: (payload) => storage.prepare(payload)
      })
    })
  )
