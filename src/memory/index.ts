import type { CompressionRequest } from "@firfi/unii"
import { Clock, Context, Effect, Layer, Schema, Semaphore } from "effect"
import { SummaryGeneration, SummaryRequest, fakeSummaryLayer } from "../summary-generation/index.ts"
import {
  StorageUnavailable,
  defaultMemorySettings,
  type MemorySettings,
  type DeliveryEvidence,
  type DeliveryPayload,
  type PriorSnapshot,
  type Receipt
} from "./contracts.ts"
import { CoreHost } from "./core-host.ts"
import { DurableMemory, sqliteLayer } from "./adapter.ts"

export * from "./contracts.ts"
export { DurableMemory, SqliteMemoryStorage, durableMemoryLayer, sqliteLayer, sqliteStorageLayer } from "./adapter.ts"

export class Memory extends Context.Service<
  Memory,
  {
    retryFailed: () => Effect.Effect<number, StorageUnavailable>
    latestInput: () => Effect.Effect<Receipt | undefined, StorageUnavailable>
    pendingReply: () => Effect.Effect<DeliveryPayload | undefined, StorageUnavailable>
    findReply: (inputDeliveryId: string) => Effect.Effect<Receipt | undefined, StorageUnavailable>
    snapshot: (before: number) => Effect.Effect<PriorSnapshot, StorageUnavailable>
    find: (deliveryId: DeliveryPayload["deliveryId"]) => Effect.Effect<DeliveryEvidence | undefined, StorageUnavailable>
    append: (message: DeliveryPayload) => Effect.Effect<Receipt, StorageUnavailable>
    page: (after: number | undefined, limit: number) => Effect.Effect<readonly Receipt[], StorageUnavailable>
  }
>()("balabol/memory") {}

const pumpIntervalMillis = 20
const unavailable = () =>
  new StorageUnavailable({ message: "Durable memory is unavailable; retry the same delivery identity" })
export const configuredUniiLayer = (settings: MemorySettings = defaultMemorySettings) =>
  Layer.effect(
    Memory,
    Effect.gen(function* () {
      const summary = yield* SummaryGeneration
      const context = yield* Effect.context<never>()
      const backend = (request: CompressionRequest, signal: AbortSignal) =>
        Effect.runPromiseWith(context)(
          Schema.decodeUnknownEffect(SummaryRequest)({ ...request, model: settings.summaryModel }).pipe(
            Effect.flatMap(summary.summarize),
            Effect.result
          ),
          { signal }
        ).then((result) => {
          if (result._tag === "Failure") throw result.failure
          return result.success
        })
      const clock = yield* Clock.Clock
      const adapter = yield* DurableMemory
      const semaphore = yield* Semaphore.make(1)
      const host = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            CoreHost.open(adapter, () => clock.currentTimeMillisUnsafe(), backend, settings.summaryConcurrency),
          catch: unavailable
        }),
        (instance) => Effect.promise(() => instance.close()).pipe(semaphore.withPermits(1))
      )
      yield* Effect.forkScoped(
        Effect.forever(
          // A failed pump records RecoveryRequired in CoreHost; snapshot/send expose or recover it.
          // Background ticks never reopen a failed store in an unbounded retry loop.
          Effect.tryPromise({ try: () => host.pump(), catch: unavailable }).pipe(
            semaphore.withPermits(1),
            Effect.catch(() => Effect.void),
            Effect.andThen(Effect.sleep(pumpIntervalMillis))
          )
        )
      )
      return Memory.of({
        retryFailed: () =>
          Effect.tryPromise({ try: () => host.retryFailed(), catch: unavailable }).pipe(semaphore.withPermits(1)),
        latestInput: () => Effect.try({ try: () => adapter.latestInput(), catch: unavailable }),
        pendingReply: () => Effect.try({ try: () => adapter.pendingReply(), catch: unavailable }),
        findReply: (id) => Effect.try({ try: () => adapter.findReply(id), catch: unavailable }),
        snapshot: (before) =>
          Effect.tryPromise({ try: () => host.snapshot(before), catch: unavailable }).pipe(semaphore.withPermits(1)),
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

export const uniiLayer = configuredUniiLayer().pipe(Layer.provide(fakeSummaryLayer))

export const memoryLayer = (path: string) => uniiLayer.pipe(Layer.provide(sqliteLayer(path)))
