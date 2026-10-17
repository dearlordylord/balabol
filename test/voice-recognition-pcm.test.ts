import { Effect, Layer } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import { SpeechRecognition, fakeRecognitionLayer } from "../src/speech-recognition/index.ts"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import { Voice, VoiceTransport, sileroSpeechActivityLayer } from "../src/voice/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { voiceTransportFixture } from "./voice-fixture.ts"
import { startVoiceRequest } from "./voice-admission-fixture.ts"
import { classifiedVoiceInput, voiceOutputLayer } from "./voice-output-fixture.ts"

// The classifier acknowledgement supplies pacing; this transport adds no wall-clock delay.
const immediateTransport = () => {
  const fixture = voiceTransportFixture()
  let receive: Parameters<VoiceTransport["Service"]["open"]>[1] | undefined
  const layer = Layer.effect(
    VoiceTransport,
    Effect.gen(function* () {
      const real = yield* VoiceTransport
      return VoiceTransport.of({
        open: (identity, frame, disconnected, connected) =>
          real.open(identity, frame, disconnected, connected).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                receive = frame
              })
            )
          )
      })
    })
  ).pipe(Layer.provide(fixture.layer))
  const send = (frame: unknown, track = "microphone") =>
    Effect.sync(() => {
      if (receive === undefined) throw new Error("Voice transport is not open")
      receive(track, frame)
    })
  return { ...fixture, layer, send }
}

it("preserves exact classified PCM across partial 512-sample recognition rollover boundaries", async () => {
  let windows = 0
  const activity = sileroSpeechActivityLayer(
    { modelPath: "fixture-model.onnx" },
    {
      open: () =>
        Effect.succeed({
          run: async () => {
            windows += 1
            return { probability: windows <= 625 ? 0.9 : 0.01, state: new Float32Array(256) }
          }
        })
    }
  )
  const input = await Effect.runPromise(classifiedVoiceInput(activity))
  const chunks: Uint8Array[] = []
  const recognition = Layer.effect(
    SpeechRecognition,
    Effect.gen(function* () {
      const real = yield* SpeechRecognition
      return SpeechRecognition.of({
        ...real,
        recognize: (request) => {
          chunks.push(request.audio.bytes.slice())
          return real.recognize(request)
        }
      })
    })
  ).pipe(
    Layer.provide(
      fakeRecognitionLayer({
        languages: ["ru", "fr", "en"],
        scripts: [{ events: [{ kind: "Final", text: "chunk", spans: [] }], delayMillis: 0, failure: null }]
      })
    )
  )
  const database = await temporaryDatabase()
  const transport = immediateTransport()
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const voice = yield* Voice
        const conversation = yield* Conversation
        const join = yield* voice.start(startVoiceRequest())
        for (let frame = 0; frame < 1000; frame++) {
          const audio = transport.audio(0)
          for (let sample = 0; sample < 320; sample++) audio.data[sample] = Math.floor((frame * 320 + sample) / 512)
          yield* input.send(transport, audio)
        }
        for (let frame = 0; frame < 52; frame++) yield* input.send(transport, transport.audio(0))
        let page = yield* conversation.page({ limit: 100 })
        for (let poll = 0; !page.messages.some((message) => message.role === "user") && poll < 200; poll++) {
          yield* Effect.sleep(5)
          page = yield* conversation.page({ limit: 100 })
        }
        expect(chunks.map((chunk) => chunk.length)).toEqual([320000, 320000, 32000])
        const expected = Buffer.alloc(640000)
        for (let sample = 0; sample < 320000; sample++) expected.writeInt16LE(Math.floor(sample / 512), sample * 2)
        expect(Buffer.concat(chunks.slice(0, 2))).toEqual(expected)
        expect(chunks[2]).toEqual(new Uint8Array(32000))
        expect(page.messages.filter((message) => message.role === "user").map((message) => message.text)).toEqual([
          "chunk chunk chunk"
        ])
        yield* voice.end(join.sessionId)
      }).pipe(
        Effect.scoped,
        Effect.provide(
          voiceOutputLayer(
            database.path,
            transport,
            fakeSynthesisLayer(),
            fakeAnswerLayer(0),
            recognition,
            undefined,
            undefined,
            input.layer
          )
        )
      )
    )
  } finally {
    await database.close()
  }
})
