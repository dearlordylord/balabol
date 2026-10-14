import { randomUUID } from "node:crypto"
import { AudioStream, Room, RoomEvent } from "@livekit/rtc-node"
import type { RemoteTrackPublication } from "@livekit/rtc-node"
import { Deferred, Effect, Fiber, Exit } from "effect"
import { describe, expect, it } from "vitest"
import type { SynthesisAudio } from "../src/speech-synthesis/index.ts"
import { VoiceTransport, liveKitLayer } from "../src/voice/index.ts"
import { liveKitFixturePath, liveKitSettings } from "./livekit-settings.ts"
const sampleRate = 24000
const frameSamples = 1200
const pollMillis = 10
const pollLimit = 300
const io = <A>(operation: () => Promise<A>) => Effect.promise(operation)
describe.skipIf(liveKitFixturePath === undefined)(
  "actual reply publication transport (synthetic PCM, not acoustic evidence)",
  () => {
    it("delivers bounded PCM on a fresh SID and fences pending capture through cancellation and close", async () => {
      const config = await liveKitSettings()
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const transport = yield* VoiceTransport
            const opened = yield* transport.open(
              { sessionId: randomUUID(), roomName: randomUUID(), participantIdentity: randomUUID() },
              () => undefined,
              () => undefined
            )
            const client = new Room()
            yield* Effect.addFinalizer(() => io(() => client.disconnect()))
            yield* io(() => client.connect(config.url, opened.join.token, { autoSubscribe: false, dynacast: false }))
            const outputEpoch = randomUUID()
            const output = yield* opened.connection.openOutput(outputEpoch)
            expect(output.publisherIdentity).toBe(opened.join.backendParticipantIdentity)
            const subscribed = yield* Deferred.make<void>()
            let frames = 0
            let samples = 0
            let cancelReader: (() => Promise<void>) | undefined
            client.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
              if (publication.sid !== output.trackSid || participant.identity !== output.publisherIdentity) return
              const reader = new AudioStream(track, { sampleRate, numChannels: 1, frameSizeMs: 20 }).getReader()
              let reading = true
              cancelReader = () => (reading ? reader.cancel() : Promise.resolve())
              void (async () => {
                try {
                  while (true) {
                    const frame = await reader.read()
                    if (frame.done) return
                    frames += 1
                    samples += frame.value.samplesPerChannel
                  }
                } catch {
                  /* Unpublication closes the native source. */
                } finally {
                  reading = false
                  reader.releaseLock()
                }
              })()
              Deferred.doneUnsafe(subscribed, Effect.void)
            })
            let publication: RemoteTrackPublication | undefined
            for (let attempt = 0; publication === undefined && attempt < pollLimit; attempt++) {
              publication = [
                ...(client.remoteParticipants.get(output.publisherIdentity)?.trackPublications.values() ?? [])
              ].find((track) => track.sid === output.trackSid)
              if (publication === undefined) yield* Effect.sleep(pollMillis)
            }
            if (publication === undefined) throw new Error("Client did not discover the exact assistant publication")
            yield* Effect.sync(() => publication?.setSubscribed(true))
            yield* Deferred.await(subscribed).pipe(Effect.timeout(3000))
            const bytes = new Uint8Array(frameSamples * 2)
            const view = new DataView(bytes.buffer)
            for (let sample = 0; sample < frameSamples; sample++)
              view.setInt16(sample * 2, Math.floor(sample / 24) % 2 === 0 ? 1200 : -1200, true)
            const audio: SynthesisAudio = {
              encoding: "pcm-s16le" as const,
              sampleRateHz: sampleRate,
              channels: 1 as const,
              sampleFrames: frameSamples,
              bytes
            }
            const capturing = yield* Effect.forever(output.capture(audio)).pipe(Effect.forkChild)
            for (let attempt = 0; frames === 0 && attempt < pollLimit; attempt++) yield* Effect.sleep(pollMillis)
            expect(frames).toBeGreaterThan(0)
            expect(samples).toBeGreaterThan(0)
            output.invalidate()
            yield* Fiber.interrupt(capturing)
            expect(Exit.isFailure(yield* Fiber.await(capturing))).toBe(true)
            yield* output.close()
            yield* output.close()
            output.invalidate()
            expect((yield* Effect.flip(output.capture(audio))).code).toBe("AudioUnavailable")
            if (cancelReader !== undefined) yield* io(cancelReader)
            const replacement = yield* opened.connection.openOutput(randomUUID())
            expect(replacement.trackSid).not.toBe(output.trackSid)
            yield* replacement.drain()
            yield* replacement.close()
            yield* opened.connection.close()
          })
        ).pipe(Effect.provide(liveKitLayer(config)))
      )
    }, 20000)
  }
)
describe.skipIf(liveKitFixturePath === undefined)("actual pending publication retirement", () => {
  it("closes a room while publication is acquiring and rejects output reuse", async () => {
    const config = await liveKitSettings()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const transport = yield* VoiceTransport
          const room = yield* transport.open(
            { sessionId: randomUUID(), roomName: randomUUID(), participantIdentity: randomUUID() },
            () => undefined,
            () => undefined
          )
          const opening = yield* room.connection.openOutput(randomUUID()).pipe(Effect.forkChild)
          yield* room.connection.close().pipe(Effect.timeout(5000))
          yield* Fiber.interrupt(opening).pipe(Effect.timeout(5000))
          expect((yield* Effect.flip(room.connection.openOutput(randomUUID()))).code).toBe("AudioUnavailable")
          yield* room.connection.close()
        })
      ).pipe(Effect.provide(liveKitLayer(config)))
    )
  }, 20000)
})
