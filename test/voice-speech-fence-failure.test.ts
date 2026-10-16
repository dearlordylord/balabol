import { classifiedVoiceInput } from "./voice-output-fixture.ts"
import { Effect, Layer } from "effect"
import { expect, it } from "vitest"
import { Conversation, InvalidInput } from "../src/conversation/index.ts"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { SpeechRecognition, fakeRecognitionLayer } from "../src/speech-recognition/index.ts"
import { fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import {
  Voice,
  VoiceLanguageConfiguration,
  VoiceOutputConfiguration,
  defaultVoiceLanguageConfiguration,
  defaultVoiceOutputSettings
} from "../src/voice/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { replyLayer } from "./reply-fixture.ts"
import { voiceTransportFixture } from "./voice-fixture.ts"
import { startVoiceRequest, voiceAdmissionsFixture } from "./voice-admission-fixture.ts"

it("rejects a provisional turn after a rejected speech fence and admits fresh speech after recovery", async () => {
  const database = await temporaryDatabase()
  const transport = voiceTransportFixture()
  const input = await Effect.runPromise(classifiedVoiceInput())
  const conversation = replyLayer(database.path, fakeAnswerLayer(0))
  let fences = 0
  const recognized: number[] = []
  const recognition = Layer.effect(
    SpeechRecognition,
    Effect.gen(function* () {
      const real = yield* SpeechRecognition
      return SpeechRecognition.of({
        ...real,
        recognize: (request) => {
          recognized.push(new DataView(request.audio.bytes.buffer, request.audio.bytes.byteOffset).getInt16(0, true))
          return real.recognize(request)
        }
      })
    })
  ).pipe(
    Layer.provide(
      fakeRecognitionLayer({
        languages: ["ru", "fr", "en"],
        scripts: [{ events: [{ kind: "Final", text: "fresh speech", spans: [] }], delayMillis: 0, failure: null }]
      })
    )
  )
  const intercepted = Layer.effect(
    Conversation,
    Effect.gen(function* () {
      const real = yield* Conversation
      return Conversation.of({
        ...real,
        fenceSpeech: (input) =>
          Effect.suspend(() => {
            fences += 1
            return fences === 1
              ? Effect.fail(new InvalidInput({ message: "Controlled speech fence rejection" }))
              : real.fenceSpeech(input)
          })
      })
    })
  ).pipe(Layer.provide(conversation))
  const application = Voice.configuredLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        input.layer,
        Layer.succeed(VoiceLanguageConfiguration, defaultVoiceLanguageConfiguration),
        Layer.succeed(VoiceOutputConfiguration, defaultVoiceOutputSettings),
        intercepted,
        transport.layer,
        fakeSynthesisLayer(),
        recognition,
        voiceAdmissionsFixture().pipe(Layer.provide(conversation))
      )
    ),
    Layer.provideMerge(conversation)
  )
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const voice = yield* Voice
          const durable = yield* Conversation
          const join = yield* voice.start(startVoiceRequest())
          for (let frame = 0; frame < 3; frame++) yield* input.send(transport, transport.audio(1200))
          let snapshot = yield* voice.snapshot(join.sessionId, 0)
          for (let attempt = 0; !snapshot.events.some((event) => event.kind === "Error") && attempt < 100; attempt++) {
            yield* Effect.sleep(5)
            snapshot = yield* voice.snapshot(join.sessionId, 0)
          }
          expect(snapshot.events.some((event) => event.kind === "Error" && event.code === "InvalidInput")).toBe(true)
          expect(snapshot.events.some((event) => event.kind === "Final" || event.kind === "Accepted")).toBe(false)
          expect((yield* durable.page({ limit: 100 })).messages).toEqual([])
          for (let frame = 0; frame < 50; frame++) yield* input.send(transport, transport.audio(0))
          for (let frame = 0; frame < 3; frame++) yield* input.send(transport, transport.audio(2400))
          for (let frame = 0; frame < 50; frame++) yield* input.send(transport, transport.audio(0))
          snapshot = yield* voice.snapshot(join.sessionId, 0)
          for (let attempt = 0; !snapshot.pending.some((input) => input.receipt !== null) && attempt < 200; attempt++) {
            yield* Effect.sleep(5)
            snapshot = yield* voice.snapshot(join.sessionId, 0)
          }
          expect(snapshot.pending.filter((input) => input.receipt !== null).map((input) => input.text)).toEqual([
            "fresh speech"
          ])
          expect(
            (yield* durable.page({ limit: 100 })).messages
              .filter((message) => message.role === "user")
              .map((message) => message.text)
          ).toEqual(["fresh speech"])
          expect(fences).toBe(2)
          expect(recognized).toEqual([2400])
          yield* voice.end(join.sessionId)
        })
      ).pipe(Effect.provide(application))
    )
  } finally {
    await database.close()
  }
})
