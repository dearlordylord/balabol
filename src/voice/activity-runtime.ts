import { Effect, Schema } from "effect"
import type { Scope } from "effect"
import { ActivityCommand, speechActivityModel } from "./activity-protocol.ts"
import { activityWorkerEntrypoint, startActivityChild } from "./activity-child.ts"
import { failed, type VoiceFailed } from "./contracts.ts"
export { speechActivityModel }
export interface ActivityModelRunner {
  readonly run: (input: Float32Array, state: Float32Array, signal?: AbortSignal) => Promise<unknown>
}
export interface ActivityRuntime {
  readonly open: (modelPath: string) => Effect.Effect<ActivityModelRunner, VoiceFailed, Scope.Scope>
}
const startupMillis = 10000
const inferenceMillis = 1000
const observeAbort = (signal: AbortSignal | undefined, stop: () => Promise<void>) => {
  const abort = () => {
    void stop().catch(() => undefined)
  }
  signal?.addEventListener("abort", abort, { once: true })
  return () => signal?.removeEventListener("abort", abort)
}
/** One Voice-owned child. A failed frame is never replayed; the next request may acquire a fresh child. */
export const activityProcessRuntime = (entrypoint: URL = activityWorkerEntrypoint): ActivityRuntime => ({
  open: (modelPath) =>
    Effect.gen(function* () {
      let handle: ReturnType<typeof startActivityChild> | undefined
      let sequence = 0
      let busy = false
      let closed = false
      const acquire = async () => {
        if (handle?.alive) return handle
        await handle?.stop()
        const next = startActivityChild(entrypoint)
        handle = next
        const ready = await next.exchange({ kind: "Load", sequence: sequence++, modelPath }, startupMillis)
        if (ready.kind !== "Ready") throw new Error("Speech activity startup failed")
        return next
      }
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          closed = true
          await handle?.stop()
        })
      )
      yield* Effect.tryPromise({
        try: acquire,
        catch: () => failed("ActivityUnavailable", "Speech activity worker startup failed")
      })
      return {
        run: async (input, state, signal) => {
          if (closed || busy) throw new Error("Speech activity worker is closed or busy")
          busy = true
          const removeAbort = observeAbort(signal, async () => {
            await handle?.stop()
          })
          try {
            signal?.throwIfAborted()
            const command = Schema.decodeUnknownSync(ActivityCommand)({
              kind: "Infer",
              sequence: sequence++,
              input: [...input],
              state: [...state]
            })
            const current = await acquire()
            const result = await current.exchange(command, inferenceMillis)
            if (result.kind !== "Result") throw new Error("Speech activity inference failed")
            return { probability: result.probability, state: Float32Array.from(result.state) }
          } catch (error) {
            await handle?.stop()
            throw error
          } finally {
            removeAbort()
            busy = false
          }
        }
      }
    })
})
export const sileroRuntime = activityProcessRuntime()
