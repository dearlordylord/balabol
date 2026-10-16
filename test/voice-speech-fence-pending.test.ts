import { classifiedVoiceInput } from "./voice-output-fixture.ts"
import { Deferred, Effect, Layer, Stream } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
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

it("continues classifying a complete turn while its speech fence awaits acknowledgement", async () => {
  const database = await temporaryDatabase()
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const input = yield* classifiedVoiceInput()
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const recognized = yield* Deferred.make<number>()
        const transport = voiceTransportFixture()
        const conversation = replyLayer(database.path, fakeAnswerLayer(0))
        const intercepted = Layer.effect(
          Conversation,
          Effect.gen(function* () {
            const real = yield* Conversation
            return Conversation.of({
              ...real,
              fenceSpeech: (input) =>
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(real.fenceSpeech(input))
                )
            })
          })
        ).pipe(Layer.provide(conversation))
        const recognition = Layer.effect(
          SpeechRecognition,
          Effect.gen(function* () {
            const real = yield* SpeechRecognition
            return SpeechRecognition.of({
              ...real,
              recognize: (input) =>
                Stream.fromEffect(Deferred.succeed(recognized, input.audio.sampleFrames)).pipe(
                  Stream.flatMap(() => real.recognize(input))
                )
            })
          })
        ).pipe(
          Layer.provide(
            fakeRecognitionLayer({
              languages: ["ru", "fr", "en"],
              scripts: [
                { events: [{ kind: "Final", text: "Complete pending turn", spans: [] }], delayMillis: 0, failure: null }
              ]
            })
          )
        )
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
        yield* Effect.gen(function* () {
          const voice = yield* Voice
          const durable = yield* Conversation
          const join = yield* voice.start(startVoiceRequest())
          for (let frame = 0; frame < 3; frame++) yield* input.send(transport, transport.audio(1200))
          yield* Deferred.await(entered).pipe(Effect.timeout("2 seconds"))
          for (let frame = 0; frame < 50; frame++) yield* input.send(transport, transport.audio(0))
          expect(yield* Deferred.await(recognized).pipe(Effect.timeout("2 seconds"))).toBe(16960)
          let snapshot = yield* voice.snapshot(join.sessionId, 0)
          expect(snapshot.status).toBe("active")
          expect(snapshot.events.filter((event) => ["Error", "Final", "Accepted"].includes(event.kind))).toEqual([])
          expect((yield* durable.page({ limit: 100 })).messages).toEqual([])
          yield* Deferred.succeed(release, undefined)
          for (let attempt = 0; !snapshot.pending.some((input) => input.receipt !== null) && attempt < 200; attempt++) {
            yield* Effect.sleep(5)
            snapshot = yield* voice.snapshot(join.sessionId, 0)
          }
          expect(snapshot.events.filter((event) => event.kind === "Accepted")).toHaveLength(1)
          expect(
            (yield* durable.page({ limit: 100 })).messages
              .filter((message) => message.role === "user")
              .map((message) => message.text)
          ).toEqual(["Complete pending turn"])
          yield* voice.end(join.sessionId)
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)), Effect.scoped, Effect.provide(application))
      })
    )
  } finally {
    await database.close()
  }
})
