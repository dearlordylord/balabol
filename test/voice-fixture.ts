import type { SynthesisAudio } from "../src/speech-synthesis/index.ts"
import { randomUUID } from "node:crypto"
import { Effect, Layer } from "effect"
import { VoiceTransport } from "../src/voice/index.ts"
import type { VoiceFrame, VoiceEvent } from "../src/voice/index.ts"
const frameSamples = 320
const speechSample = 1200
const silenceFrames = 20
const onsetFrames = 3
export const voiceTransportFixture = (joinImmediately = true) => {
  let receive: ((track: string, raw: unknown) => void) | undefined
  let markJoined: (() => void) | undefined
  let opens = 0
  let disconnect: (() => void) | undefined
  const publications: { outputEpoch: string; invalidated: boolean; closed: boolean }[] = []
  const captured: { outputEpoch: string; frames: number }[] = []
  const backendParticipantIdentity = randomUUID()
  const published: VoiceEvent[] = []
  let closed = false
  const layer = Layer.succeed(VoiceTransport, {
    open: (identity, frame, disconnected, connected) =>
      Effect.sync(() => {
        receive = frame
        disconnect = disconnected
        closed = false
        opens += 1
        markJoined = connected
        if (joinImmediately) connected()
        return {
          join: {
            ...identity,
            backendParticipantIdentity,
            mediaUrl: "ws://localhost:7880",
            token: "fixture-microphone-only-token",
            expiresAt: 120000
          },
          connection: {
            openOutput: (outputEpoch) =>
              Effect.sync(() => {
                let valid = true
                const lifecycle = { outputEpoch, invalidated: false, closed: false }
                publications.push(lifecycle)
                return {
                  publisherIdentity: backendParticipantIdentity,
                  trackSid: `TR_${randomUUID()}`,
                  invalidate: () => {
                    valid = false
                    lifecycle.invalidated = true
                  },
                  close: () =>
                    Effect.sync(() => {
                      valid = false
                      lifecycle.closed = true
                    }),
                  drain: () => Effect.void,
                  capture: (audio: SynthesisAudio) =>
                    Effect.sync(() => {
                      if (valid) captured.push({ outputEpoch, frames: audio.sampleFrames })
                    })
                }
              }),
            close: () =>
              Effect.sync(() => {
                closed = true
              }),
            publish: (event) =>
              Effect.sync(() => {
                published.push(event)
              })
          }
        }
      })
  })
  const send = (raw: unknown, track = "microphone") =>
    Effect.sync(() => receive?.(track, raw)).pipe(Effect.andThen(Effect.sleep(1)))
  const audio = (sample: number): VoiceFrame => ({
    sampleRate: 16000,
    channels: 1,
    samplesPerChannel: 320,
    data: new Int16Array(frameSamples).fill(sample)
  })
  const segment = Effect.gen(function* () {
    for (let i = 0; i < onsetFrames; i++) yield* send(audio(speechSample))
    for (let i = 0; i < silenceFrames; i++) yield* send(audio(0))
  })
  return {
    layer,
    send,
    audio,
    segment,
    published,
    captured,
    publications,
    joined: () => markJoined?.(),
    opens: () => opens,
    disconnect: () => disconnect?.(),
    closed: () => closed
  }
}
