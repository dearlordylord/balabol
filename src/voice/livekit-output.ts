import { AudioFrame, AudioSource, LocalAudioTrack, TrackPublishOptions, TrackSource } from "@livekit/rtc-node"
import type { LocalTrack } from "@livekit/rtc-node"
import { Effect, Scope, Exit, Schema } from "effect"
import { SynthesisAudio } from "../speech-synthesis/index.ts"
import { failed } from "./contracts.ts"
import type { ReplyDeliveryAuthorization } from "../conversation/index.ts"
import type { AudioPublication, VoiceFailed } from "./contracts.ts"
const sampleRate = 24000
const queueMillis = 100
const captureMillis = 1000
const publicationMillis = 5000
const sampleBytes = 2
const io = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: () => failed("AudioUnavailable", "Reply audio transport failed") })
/** Narrow RTC publication port; native source/track lifetimes remain owned here. */
export type ReplyPublisher = {
  publishTrack: (track: LocalTrack, options: TrackPublishOptions) => Promise<{ readonly sid: string | undefined }>
  unpublishTrack: (sid: string, stopOnUnpublish?: boolean) => Promise<void>
}
const decodeAudioFrame = (audio: SynthesisAudio) => {
  const data = new Int16Array(audio.sampleFrames)
  const view = new DataView(audio.bytes.buffer, audio.bytes.byteOffset, audio.bytes.byteLength)
  for (let index = 0; index < data.length; index++) data[index] = view.getInt16(index * sampleBytes, true)
  return new AudioFrame(data, sampleRate, 1, audio.sampleFrames)
}
export const openLiveKitOutput = (
  local: ReplyPublisher,
  parent: Scope.Scope,
  publisherIdentity: string,
  outputEpoch: string,
  authorization: ReplyDeliveryAuthorization,
  abortConnection: () => Effect.Effect<void>
): Effect.Effect<AudioPublication, VoiceFailed> =>
  Effect.gen(function* () {
    if (!authorization.isAuthorized() || authorization.signal.aborted)
      return yield* failed("AudioUnavailable", "Reply publication authorization was revoked")
    const scope = yield* Scope.fork(parent)
    return yield* Effect.gen(function* () {
      const source = new AudioSource(sampleRate, 1, queueMillis)
      const track = LocalAudioTrack.createAudioTrack(`balabol.reply.${outputEpoch}`, source)
      let valid = true
      let closing = false
      let pending: Promise<void> | undefined
      const identity = { sid: "" }
      const acquisition: { pending?: Promise<{ readonly sid: string | undefined }> } = {}
      let acquired = false
      let released = false
      const releaseNative = async () => {
        if (released) return
        released = true
        await track.close(false)
        if (!source.closed) await source.close()
      }
      const releaseLate = () => {
        // SDK unpublish uses SID, not Source/Track handles; publication has already settled here.
        if (identity.sid !== "") void local.unpublishTrack(identity.sid, false).catch(() => undefined)
        void releaseNative().catch(() => undefined)
      }
      const clear = () => {
        if (!closing && !source.closed) source.clearQueue()
      }
      const invalidate = () => {
        valid = false
        clear()
      }
      const authorized = () => valid && !closing && !authorization.signal.aborted && authorization.isAuthorized()
      authorization.signal.addEventListener("abort", invalidate, { once: true })
      if (!authorization.isAuthorized() || authorization.signal.aborted) invalidate()
      yield* Scope.addFinalizer(
        scope,
        Effect.gen(function* () {
          invalidate()
          authorization.signal.removeEventListener("abort", invalidate)
          closing = true
          if (acquisition.pending !== undefined && !acquired) {
            // Keep borrowed handles alive for the SDK's queued publish until its promise settles.
            yield* abortConnection()
            return
          }
          if (pending !== undefined)
            yield* io(() => pending ?? Promise.resolve()).pipe(Effect.timeout(captureMillis), Effect.ignore)
          if (identity.sid !== "")
            yield* io(() => local.unpublishTrack(identity.sid, false)).pipe(
              Effect.timeout(captureMillis),
              Effect.ignore
            )
          yield* io(releaseNative).pipe(Effect.timeout(captureMillis), Effect.ignore)
        })
      )
      if (!authorized()) return yield* failed("AudioUnavailable", "The reply publication scope is closed")
      const operation = local.publishTrack(track, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }))
      acquisition.pending = operation
      void operation.then(
        (publication) => {
          acquired = true
          identity.sid = publication.sid ?? ""
          if (closing) releaseLate()
        },
        () => {
          acquired = true
          if (closing) releaseLate()
        }
      )
      const publication = yield* io(() => operation).pipe(
        Effect.timeout(publicationMillis),
        Effect.mapError(() => failed("AudioUnavailable", "Reply publication failed or exceeded its deadline"))
      )
      if (!authorized()) return yield* failed("AudioUnavailable", "Reply publication was retired before readiness")
      const sid = publication.sid
      if (sid === undefined) return yield* failed("AudioUnavailable", "Reply audio publication lacks an identity")
      identity.sid = sid
      const capture = (raw: SynthesisAudio) =>
        SchemaAudio(raw).pipe(
          Effect.flatMap((audio) =>
            io(async () => {
              if (!authorized() || pending !== undefined) throw new Error("Output is invalidated or capture is busy")
              const frame = decodeAudioFrame(audio)
              if (!authorized()) throw new Error("Output authorization was revoked")
              const operation = source.captureFrame(frame)
              pending = operation
              try {
                await operation
                if (!authorized()) throw new Error("Output authorization was revoked during capture")
              } finally {
                if (pending === operation) pending = undefined
                if (!valid) clear()
              }
            })
          ),
          Effect.timeout(captureMillis),
          Effect.mapError(() => failed("AudioUnavailable", "Reply audio capture failed or exceeded its deadline")),
          Effect.onInterrupt(() => Effect.sync(invalidate))
        )
      return {
        publisherIdentity,
        trackSid: sid,
        invalidate,
        capture,
        drain: () =>
          io(async () => {
            if (!authorized()) throw new Error("Output authorization was revoked")
            await source.waitForPlayout()
            if (!authorized()) throw new Error("Output authorization was revoked during drain")
          }).pipe(
            Effect.timeout(captureMillis),
            Effect.mapError(() => failed("AudioUnavailable", "Reply audio drain exceeded its deadline"))
          ),
        close: () => Scope.close(scope, Exit.void)
      }
    }).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void)))
  })
const SchemaAudio = (raw: SynthesisAudio) =>
  Schema.decodeUnknownEffect(SynthesisAudio)(raw).pipe(
    Effect.mapError(() => failed("InvalidAudio", "Invalid supplied synthesis PCM"))
  )
