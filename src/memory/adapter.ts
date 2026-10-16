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
    latestInput: () => Receipt | undefined
    pendingReply: () => DeliveryPayload | undefined
    storage: Storage
    findReply: (inputDeliveryId: string) => Receipt | undefined
    prepare: (payload: DeliveryPayload) => void
    find: (deliveryId: DeliveryPayload["deliveryId"]) => DeliveryEvidence | undefined
    page: (after: number | undefined, limit: number) => readonly Receipt[]
    olderPage: (before: number | undefined, limit: number) => readonly Receipt[]
  }
>()("balabol/memory/durable") {}

/** Composition-only resource: its lease outlives all adapters sharing this database. */
export class SqliteMemoryStorage extends Context.Service<SqliteMemoryStorage, { readonly storage: SqliteStorage }>()(
  "balabol/memory/sqlite-resource"
) {}

export const sqliteStorageLayer = (path: string) =>
  Layer.effect(
    SqliteMemoryStorage,
    Effect.gen(function* () {
      const storage = yield* Effect.acquireRelease(
        Effect.try({
          try: () => new SqliteStorage(path),
          catch: () => new WriterUnavailable({ message: "Cannot acquire durable memory writer" })
        }),
        (instance) => Effect.promise(() => instance.close())
      )
      return SqliteMemoryStorage.of({ storage })
    })
  )

export const durableMemoryLayer = Layer.effect(
  DurableMemory,
  Effect.gen(function* () {
    const { storage } = yield* SqliteMemoryStorage
    return DurableMemory.of({
      storage,
      latestInput: () => storage.latestInput(),
      pendingReply: () => storage.pendingReply(),
      findReply: (id) => storage.findReply(id),
      find: (id) => {
        const row = storage.find(id)
        if (row === undefined) return undefined
        const payload = {
          deliveryId: row.deliveryId,
          text: row.text,
          languageSpans: row.languageSpans,
          detectedLanguage: row.detectedLanguage,
          responseLanguage: row.responseLanguage,
          role: row.role,
          ...(row.inputDeliveryId === null ? {} : { inputDeliveryId: row.inputDeliveryId }),
          ...(row.responseId === null ? {} : { responseId: row.responseId }),
          ...(row.outcome === null ? {} : { outcome: row.outcome })
        }
        return Schema.decodeUnknownSync(DeliveryEvidence)(
          row.firstId === null
            ? { state: "Intent", payload }
            : { state: "Accepted", receipt: { ...payload, recordId: row.firstId, position: row.position } }
        )
      },
      page: (after, limit) => storage.page(after, limit),
      olderPage: (before, limit) => storage.olderPage(before, limit),
      prepare: (payload) => storage.prepare(payload)
    })
  })
)

/** Standalone memory keeps the same acquisition path as shared application composition. */
export const sqliteLayer = (path: string) => durableMemoryLayer.pipe(Layer.provide(sqliteStorageLayer(path)))
