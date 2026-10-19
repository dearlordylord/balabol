import { Clock, Effect, Exit, Queue, Schema } from "effect"
import type { Scope } from "effect"
import { auditIdentity, withAuditSpan } from "../operation-audit/index.ts"
import type { VoiceFailed } from "./contracts.ts"
import { VoiceFrame } from "./contracts.ts"
import type { ActivityStream, ActivityWindow } from "./activity.ts"
import type { SessionState } from "./session-state.ts"
import type { SessionEvent } from "./session-events.ts"
import { recordVoiceDiagnostic, type VoiceDiagnostics } from "./diagnostics.ts"

const queueCapacity = 8
const frameMillis = 20
const maximumQueueAgeMillis = queueCapacity * frameMillis
const nanosPerMilli = 1000000
const maximumDroppedFrames = 65535
interface Frame {
  readonly kind: "Frame"
  readonly epoch: number
  readonly generation: number
  readonly track: string
  readonly audio: VoiceFrame
  readonly received: bigint
}
interface Gap {
  readonly kind: "Gap"
  readonly generation: number
}
/** Bounded PCM resource ingress; missing audio is an explicit owner event, never media disconnection. */
export const makeCaptureIngress = (port: {
  readonly scope: Scope.Scope
  readonly current: () => SessionState
  readonly retired: () => boolean
  readonly activity: ActivityStream
  readonly post: (event: SessionEvent) => Effect.Effect<SessionState, VoiceFailed>
  readonly notify: (event: SessionEvent) => void
  readonly classified: (windows: readonly ActivityWindow[], generation: number) => Effect.Effect<void, VoiceFailed>
  readonly diagnostics: VoiceDiagnostics["Service"]
}) =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock
    const frames = yield* Queue.make<Frame | Gap>({ capacity: queueCapacity })
    let epoch = 0
    let operation = 0
    let pendingGap = false
    let gapStarted = clock.monotonicTimeNanosUnsafe()
    let dropped = 0
    let processingMillis = 0
    let processingStarted: bigint | undefined
    const elapsed = (start: bigint) => Number(clock.monotonicTimeNanosUnsafe() - start) / nanosPerMilli
    const incrementDropped = () => {
      dropped = Math.min(maximumDroppedFrames, dropped + 1)
    }
    const gap = (generation: number, queueWaitMillis: number, source: "Incoming" | "Processing" = "Incoming") => {
      const depth = Queue.sizeUnsafe(frames)
      epoch++
      pendingGap = true
      gapStarted = clock.monotonicTimeNanosUnsafe()
      incrementDropped()
      if (processingStarted !== undefined && source === "Incoming") incrementDropped()
      let queued = Queue.takeUnsafe(frames)
      while (queued !== undefined) {
        if (Exit.isSuccess(queued) && queued.value.kind === "Frame")
          queueWaitMillis = Math.max(queueWaitMillis, elapsed(queued.value.received))
        incrementDropped()
        queued = Queue.takeUnsafe(frames)
      }
      recordVoiceDiagnostic(port.diagnostics, {
        cause: "queueOverflow",
        applied: true,
        sessionId: port.current().id,
        generation,
        capturePressure: {
          queueDepth: depth,
          droppedFrames: dropped,
          queueWaitMillis,
          processingMillis: processingStarted === undefined ? processingMillis : elapsed(processingStarted)
        }
      })
      Queue.offerUnsafe(frames, { kind: "Gap", generation })
    }
    const processFrame = (value: Frame) =>
      Effect.gen(function* () {
        if (value.epoch !== epoch) return
        const wait = elapsed(value.received)
        if (wait > maximumQueueAgeMillis) {
          gap(value.generation, wait)
          return
        }
        const selected = ++operation
        const next = yield* port.post({
          kind: "Frame",
          operation: selected,
          generation: value.generation,
          track: value.track,
          samples: value.audio.samplesPerChannel
        })
        if (next.classification?.operation !== selected) return
        const started = clock.monotonicTimeNanosUnsafe()
        processingStarted = started
        yield* Effect.suspend(() =>
          port.current().classification?.operation === selected && value.epoch === epoch
            ? port.activity.push(value.audio)
            : Effect.succeed([])
        ).pipe(
          withAuditSpan("voice.activity", undefined, { session: auditIdentity(next.id), generation: next.generation }),
          Effect.flatMap((windows) =>
            Effect.suspend(() => {
              if (value.epoch !== epoch) return Effect.void
              const age = elapsed(value.received)
              if (age > maximumQueueAgeMillis) {
                gap(next.generation, age, "Processing")
                return Effect.void
              }
              return port.classified(windows, next.generation)
            })
          ),
          Effect.catch((error) =>
            value.epoch === epoch
              ? port
                  .post({
                    kind: "CaptureFailed",
                    generation: next.generation,
                    operation: selected,
                    code: error.code,
                    message: error.message
                  })
                  .pipe(Effect.asVoid, Effect.ignore)
              : Effect.void
          ),
          Effect.ensuring(
            Effect.sync(() => {
              processingMillis = elapsed(started)
              processingStarted = undefined
              port.notify({ kind: "Classified", operation: selected })
            })
          )
        )
      })
    const recovered = (value: Gap, current: SessionState) =>
      Effect.sync(() => {
        if (current.phase !== "active" || current.muted || current.generation !== value.generation + 1) return
        pendingGap = false
        recordVoiceDiagnostic(port.diagnostics, {
          cause: "captureRecovered",
          applied: true,
          sessionId: current.id,
          generation: current.generation,
          capturePressure: {
            queueDepth: Queue.sizeUnsafe(frames),
            droppedFrames: dropped,
            queueWaitMillis: 0,
            processingMillis,
            gapMillis: elapsed(gapStarted)
          }
        })
      })
    const consume = (value: Frame | Gap) =>
      value.kind === "Frame"
        ? processFrame(value)
        : port.post({ kind: "CaptureGap", generation: value.generation }).pipe(
            Effect.tap((current) => recovered(value, current)),
            Effect.ensuring(
              Effect.sync(() => {
                pendingGap = false
                dropped = 0
              })
            ),
            Effect.asVoid,
            Effect.ignore
          )
    yield* Effect.forever(Queue.take(frames).pipe(Effect.flatMap(consume))).pipe(Effect.forkIn(port.scope))
    return (track: string, raw: unknown) => {
      const current = port.current()
      if (port.retired() || current.phase !== "active" || current.muted || current.retiredTracks.includes(track)) return
      if (pendingGap) {
        incrementDropped()
        return
      }
      const parsed = Schema.decodeUnknownExit(VoiceFrame)(raw)
      if (Exit.isFailure(parsed)) {
        port.notify({
          kind: "CaptureFailed",
          generation: current.generation,
          operation: null,
          code: "InvalidAudio",
          message: "Expected 16 kHz mono 20 ms PCM audio"
        })
        return
      }
      const audio = parsed.value
      if (
        !Queue.offerUnsafe(frames, {
          kind: "Frame",
          epoch,
          generation: current.generation,
          track,
          audio: { ...audio, data: audio.data.slice() },
          received: clock.monotonicTimeNanosUnsafe()
        })
      )
        gap(current.generation, 0)
    }
  })
