import { Memory as UniiMemory } from "@firfi/unii"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { Receipt, StorageUnavailable } from "./contracts.ts"
import type { DeliveryEvidence, DeliveryPayload } from "./contracts.ts"
import { DurableMemory, sqliteLayer } from "./adapter.ts"

export * from "./contracts.ts"
export { DurableMemory, sqliteLayer } from "./adapter.ts"

export class Memory extends Context.Service<
  Memory,
  {
    find: (deliveryId: DeliveryPayload["deliveryId"]) => Effect.Effect<DeliveryEvidence | undefined, StorageUnavailable>
    append: (message: DeliveryPayload) => Effect.Effect<Receipt, StorageUnavailable>
    page: (after: number | undefined, limit: number) => Effect.Effect<readonly Receipt[], StorageUnavailable>
  }
>()("balabol/memory") {}

const unavailable = () =>
  new StorageUnavailable({ message: "Durable memory is unavailable; retry the same delivery identity" })
export const uniiLayer = Layer.effect(
  Memory,
  Effect.gen(function* () {
    const clock = yield* Clock.Clock
    const adapter = yield* DurableMemory
    const storage = adapter.storage
    const core = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => UniiMemory.open({ storage, now: () => clock.currentTimeMillisUnsafe() }),
        catch: unavailable
      }),
      (instance) => Effect.promise(() => instance.close())
    )
    return Memory.of({
      find: (deliveryId) => Effect.try({ try: () => adapter.find(deliveryId), catch: unavailable }),
      append: (message) =>
        Effect.tryPromise({
          try: async () => {
            adapter.prepare(message)
            const receipt = await core.append({ kind: "user", text: message.text })
            const ledger = adapter.find(message.deliveryId)
            if (ledger?.state !== "Accepted" || ledger.receipt.recordId !== receipt.firstId)
              throw new Error("Missing durable receipt")
            return Schema.decodeUnknownSync(Receipt)({
              ...message,
              recordId: receipt.firstId,
              position: ledger.receipt.position
            })
          },
          catch: unavailable
        }),
      page: (after, limit) => Effect.try({ try: () => adapter.page(after, limit), catch: unavailable })
    })
  })
)

export const memoryLayer = (path: string) => uniiLayer.pipe(Layer.provide(sqliteLayer(path)))
