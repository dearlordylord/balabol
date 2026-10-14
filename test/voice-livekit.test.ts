import { liveKitFixturePath, liveKitSettings } from "./livekit-settings.ts"
import { RoomServiceClient } from "livekit-server-sdk"
import { randomUUID } from "node:crypto"
import {
  AudioFrame,
  AudioSource,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackPublishOptions,
  TrackSource
} from "@livekit/rtc-node"
import { Effect, Redacted, Schema, Clock, Fiber, Exit, Deferred } from "effect"
import { describe, expect, it } from "vitest"
import { VoiceTransport, liveKitLayer, VoiceFrame, VoiceEvent } from "../src/voice/index.ts"
const io = <A>(operation: () => Promise<A>) => Effect.promise(operation)
const sourceRate = 16000
const frameSamples = 320
const maximumCaptureFrames = 250
const subscriptionChecks = 100
const readinessPollMillis = 50
const waveformFrequency = 440
const waveformAmplitude = 1200
const audioQueueMillis = 100
const tooLarge = 20000
const disconnectObservationMillis = 5000
describe.skipIf(liveKitFixturePath === undefined)(
  "real LiveKit adapter contract (synthetic audio, not microphone evidence)",
  () => {
    it("issues constrained joins, receives microphone PCM and closes/replaces tracks", async () => {
      const config = await liveKitSettings()
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const transport = yield* VoiceTransport
            const frames: unknown[] = []
            const disconnected = yield* Deferred.make<void>()
            let joined = false
            const identity = { sessionId: randomUUID(), roomName: randomUUID(), participantIdentity: randomUUID() }
            const opened = yield* transport.open(
              identity,
              (_track, frame) => frames.push(frame),
              () => {
                Deferred.doneUnsafe(disconnected, Effect.void)
              },
              () => {
                joined = true
              }
            )
            const payload = Schema.decodeUnknownSync(
              Schema.Struct({
                sub: Schema.String,
                video: Schema.Struct({
                  room: Schema.String,
                  canPublish: Schema.Boolean,
                  canSubscribe: Schema.Boolean,
                  canPublishData: Schema.Boolean,
                  canPublishSources: Schema.Array(Schema.String)
                })
              })
            )(JSON.parse(Buffer.from(opened.join.token.split(".")[1] ?? "", "base64url").toString()))
            expect(payload.sub).toBe(identity.participantIdentity)
            expect(payload.video).toEqual({
              room: identity.roomName,
              canPublish: true,
              canSubscribe: true,
              canPublishData: false,
              canPublishSources: ["microphone"]
            })
            const client = new Room()
            yield* Effect.addFinalizer(() => io(() => client.disconnect()))
            const events: Uint8Array[] = []
            client.on(RoomEvent.DataReceived, (bytes) => events.push(bytes))
            yield* io(() => client.connect(config.url, opened.join.token, { autoSubscribe: false, dynacast: false }))
            const local = client.localParticipant
            if (local === undefined) throw new Error("Missing client participant")
            const source = new AudioSource(sourceRate, 1, audioQueueMillis)
            yield* Effect.addFinalizer(() => io(() => source.close()))
            const first = LocalAudioTrack.createAudioTrack("fixture", source)
            yield* Effect.addFinalizer(() => io(() => first.close()))
            const publishOptions = new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE })
            let subscribed = false
            client.on(RoomEvent.LocalTrackSubscribed, (track) => {
              if (track === first) subscribed = true
            })
            const publication = yield* io(() => local.publishTrack(first, publishOptions))
            for (let check = 0; !subscribed && check < subscriptionChecks; check++)
              yield* Effect.sleep(readinessPollMillis)
            expect(subscribed).toBe(true)
            // Send bounded format-valid PCM until received audio proves the media route, not merely signaling.
            for (let index = 0; frames.length === 0 && index < maximumCaptureFrames; index++) {
              const data = Int16Array.from({ length: frameSamples }, (_, sample) =>
                Math.round(
                  waveformAmplitude *
                    Math.sin((2 * Math.PI * waveformFrequency * (index * frameSamples + sample)) / sourceRate)
                )
              )
              yield* io(() => source.captureFrame(new AudioFrame(data, sourceRate, 1, frameSamples)))
              yield* io(() => source.waitForPlayout())
            }
            expect(frames.length).toBeGreaterThan(0)
            expect(joined).toBe(true)
            expect(frames.every((frame) => Schema.is(VoiceFrame)(frame))).toBe(true)
            const interim = {
              kind: "Interim",
              sequence: 1,
              sessionId: identity.sessionId,
              utteranceId: randomUUID(),
              text: "tentative"
            }
            yield* opened.connection.publish(Schema.decodeUnknownSync(VoiceEvent)(interim))
            for (let wait = 0; events.length === 0 && wait < 20; wait++) yield* Effect.sleep(50)
            expect(events.length).toBeGreaterThan(0)
            const oversized = yield* Effect.flip(
              opened.connection.publish({
                kind: "Interim",
                sequence: 2,
                sessionId: identity.sessionId,
                utteranceId: randomUUID(),
                text: "x".repeat(tooLarge)
              })
            )
            expect(oversized.code).toBe("EventTooLarge")
            if (publication.sid !== undefined) yield* io(() => local.unpublishTrack(publication.sid ?? ""))
            const next = LocalAudioTrack.createAudioTrack("replacement", source)
            yield* Effect.addFinalizer(() => io(() => next.close()))
            yield* io(() => local.publishTrack(next, publishOptions))
            yield* Effect.sleep(100)
            yield* io(() => client.disconnect())
            // The remote departure callback follows signaling propagation, not a fixed delay.
            yield* Deferred.await(disconnected).pipe(Effect.timeout(disconnectObservationMillis))
            expect(yield* Deferred.isDone(disconnected)).toBe(true)
            yield* opened.connection.close()
            yield* opened.connection.close()
          })
        ).pipe(Effect.provide(liveKitLayer(config)))
      )
    }, 20000)
    it("releases acquired rooms after post-connect failure and cancellation", async () => {
      const config = await liveKitSettings()
      const admin = new RoomServiceClient(
        config.url.replace(/^ws/u, "http"),
        config.apiKey,
        Redacted.value(config.apiSecret)
      )
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const transport = yield* VoiceTransport
            const clock = yield* Clock.Clock
            for (const outcome of ["failure", "cancellation"]) {
              const identity = { sessionId: randomUUID(), roomName: randomUUID(), participantIdentity: randomUUID() }
              let acquired = false
              const currentTimeMillis = Effect.sync(() => {
                acquired = true
              }).pipe(
                Effect.andThen(
                  outcome === "failure" ? Effect.die("Fixture clock failure after connection") : Effect.never
                )
              )
              const opening = transport
                .open(
                  identity,
                  () => undefined,
                  () => undefined,
                  () => undefined
                )
                .pipe(
                  Effect.provideService(Clock.Clock, {
                    sleep: (duration) => clock.sleep(duration),
                    currentTimeMillis,
                    currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
                    currentTimeNanos: clock.currentTimeNanos,
                    currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
                    monotonicTimeNanos: clock.monotonicTimeNanos,
                    monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe()
                  }),
                  Effect.forkChild
                )
              const task = yield* opening
              for (let wait = 0; !acquired && wait < 500; wait++) yield* Effect.sleep(10)
              expect(acquired).toBe(true)
              if (outcome === "failure") expect(Exit.isFailure(yield* Fiber.await(task))).toBe(true)
              else yield* Fiber.interrupt(task)
              let participants = yield* io(() => admin.listParticipants(identity.roomName))
              for (let wait = 0; participants.length > 0 && wait < 100; wait++) {
                yield* Effect.sleep(10)
                participants = yield* io(() => admin.listParticipants(identity.roomName))
              }
              expect(participants).toEqual([])
            }
          })
        ).pipe(Effect.provide(liveKitLayer(config)))
      )
    }, 20000)
  }
)
