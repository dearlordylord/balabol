import { Effect, Schema } from "effect"
import { expect, it } from "vitest"
import { VoiceDiagnostics, voiceDiagnosticsLayer, VoiceDiagnosticRecord } from "../src/voice/index.ts"
import { recordVoiceDiagnostic } from "../src/voice/diagnostics.ts"
const identity = "11111111-1111-4111-8111-111111111111"
const snapshot = (value: string) =>
  Schema.decodeUnknownSync(Schema.Struct({ events: Schema.Array(VoiceDiagnosticRecord) }))(JSON.parse(value))

it("persists validated content-free capture pressure metrics and rejects invalid queue depth", async () => {
  const writes: string[] = []
  await Effect.runPromise(
    Effect.gen(function* () {
      const diagnostics = yield* VoiceDiagnostics
      diagnostics.record({
        cause: "queueOverflow",
        sessionId: identity,
        applied: true,
        capturePressure: { queueDepth: 8, droppedFrames: 10, queueWaitMillis: 172, processingMillis: 184 }
      })
      yield* Effect.yieldNow
      expect(snapshot(writes.at(-1) ?? "").events[0]?.capturePressure).toEqual({
        queueDepth: 8,
        droppedFrames: 10,
        queueWaitMillis: 172,
        processingMillis: 184
      })
      recordVoiceDiagnostic(diagnostics, {
        cause: "queueOverflow",
        sessionId: identity,
        applied: true,
        capturePressure: { queueDepth: 9, droppedFrames: 10, queueWaitMillis: 172, processingMillis: 184 }
      })
      yield* Effect.yieldNow
      expect(snapshot(writes.at(-1) ?? "").events).toHaveLength(1)
      expect(writes.join("")).not.toContain(identity)
    }).pipe(
      Effect.provide(
        voiceDiagnosticsLayer({
          write: async (value) => {
            writes.push(value)
          }
        })
      )
    )
  )
})
