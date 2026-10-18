import type { AudioFrame } from "@livekit/rtc-node"
import { Cause, Effect } from "effect"
import { auditIdentity, withAuditSpan } from "../operation-audit/index.ts"
import { VoiceFailed } from "./contracts.ts"

type AudioReader = Pick<ReadableStreamDefaultReader<AudioFrame>, "read" | "cancel" | "releaseLock">
const cleanupMillis = 1000
const failure = () =>
  new VoiceFailed({
    code: "TransportUnavailable",
    message: "Microphone audio stream failed",
    diagnostic: { category: "Media", reason: "Transport", provider: "livekit" }
  })
const cleanup = (work: Effect.Effect<unknown, unknown>, sessionId: string, operation: "cancel" | "release-lock") =>
  work.pipe(
    Effect.interruptible,
    Effect.timeout(cleanupMillis),
    Effect.mapError((error) =>
      error instanceof VoiceFailed
        ? error
        : new VoiceFailed({
            code: "TransportUnavailable",
            message: "Microphone cleanup deadline exceeded",
            diagnostic: { category: "Media", reason: "Deadline", provider: "livekit" }
          })
    ),
    withAuditSpan("voice.release", undefined, { session: auditIdentity(sessionId), resource: "capture", operation }),
    Effect.ignore
  )
export const cancelLiveKitReader = (reader: AudioReader, sessionId: string) =>
  cleanup(Effect.tryPromise({ try: () => reader.cancel(), catch: failure }), sessionId, "cancel")

/** Native reader work stays outside session state; the supplied generation fence owns late input. */
export const drainLiveKitInput = (port: {
  readonly reader: AudioReader
  readonly sessionId: string
  readonly generation: number
  readonly current: () => boolean
  readonly frame: (frame: AudioFrame) => void
  readonly disconnected: () => void
}) =>
  Effect.gen(function* () {
    while (port.current()) {
      const next = yield* Effect.tryPromise({ try: () => port.reader.read(), catch: failure }).pipe(
        Effect.catch((error) => (port.current() ? Effect.fail(error) : Effect.interrupt))
      )
      if (next.done) return
      if (port.current()) yield* Effect.sync(() => port.frame(next.value))
    }
  }).pipe(
    withAuditSpan("voice.capture", undefined, { session: auditIdentity(port.sessionId), generation: port.generation }),
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        if (port.current() && !Cause.hasInterruptsOnly(cause)) port.disconnected()
      })
    ),
    Effect.ensuring(
      cancelLiveKitReader(port.reader, port.sessionId).pipe(
        Effect.ensuring(
          Effect.try({ try: () => port.reader.releaseLock(), catch: failure }).pipe(
            withAuditSpan("voice.release", undefined, {
              session: auditIdentity(port.sessionId),
              resource: "capture",
              operation: "release-lock"
            }),
            Effect.ignore
          )
        )
      )
    )
  )
