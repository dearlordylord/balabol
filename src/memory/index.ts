import { Clock, Context, Effect, Layer, Semaphore } from "effect"
import { StorageUnavailable } from "./contracts.ts"
import type { DeliveryEvidence, DeliveryPayload, Receipt } from "./contracts.ts"
import { CoreHost } from "./core-host.ts"
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
    const semaphore = yield* Semaphore.make(1)
    const host = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => CoreHost.open(adapter, () => clock.currentTimeMillisUnsafe()),
        catch: unavailable
      }),
      (instance) => Effect.promise(() => instance.close()).pipe(semaphore.withPermits(1))
    )
    return Memory.of({
      find: (deliveryId) => Effect.try({ try: () => adapter.find(deliveryId), catch: unavailable }),
      append: (message) =>
        Effect.tryPromise({ try: () => host.append(message), catch: unavailable }).pipe(
          semaphore.withPermits(1),
          Effect.uninterruptible
        ),
      page: (after, limit) => Effect.try({ try: () => adapter.page(after, limit), catch: unavailable })
    })
  })
)

export const memoryLayer = (path: string) => uniiLayer.pipe(Layer.provide(sqliteLayer(path)))
