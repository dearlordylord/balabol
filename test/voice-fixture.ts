import { Effect, Layer } from "effect"
import { VoiceTransport } from "../src/voice/index.ts"
import type { VoiceFrame, VoiceEvent } from "../src/voice/index.ts"
const frameSamples = 320
const speechSample = 1200
const silenceFrames = 20
export const voiceTransportFixture = () => {
  let receive: ((track: string, raw: unknown) => void) | undefined
  let disconnect: (() => void) | undefined
  const published: VoiceEvent[] = []
  let closed = false
  const layer = Layer.succeed(VoiceTransport, {
    open: (identity, frame, disconnected) =>
      Effect.sync(() => {
        receive = frame
        disconnect = disconnected
        closed = false
        return {
          join: {
            ...identity,
            mediaUrl: "ws://localhost:7880",
            token: "fixture-microphone-only-token",
            expiresAt: 120000
          },
          connection: {
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
    yield* send(audio(speechSample))
    for (let i = 0; i < silenceFrames; i++) yield* send(audio(0))
  })
  return { layer, send, audio, segment, published, disconnect: () => disconnect?.(), closed: () => closed }
}
