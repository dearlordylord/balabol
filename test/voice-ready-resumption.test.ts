import { Deferred, Effect, Layer, Queue } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { fakeRecognitionLayer } from "../src/speech-recognition/index.ts"
import { fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import {
  Voice,
  VoiceDiagnostics,
  VoiceLanguageConfiguration,
  VoiceOutputConfiguration,
  defaultVoiceLanguageConfiguration,
  defaultVoiceOutputSettings
} from "../src/voice/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { replyLayer } from "./reply-fixture.ts"
import { startVoiceRequest, voiceAdmissionsFixture } from "./voice-admission-fixture.ts"
import { classifiedVoiceInput } from "./voice-output-fixture.ts"
import { voiceTransportFixture } from "./voice-fixture.ts"

it("extends an already recognized quiet turn while its original fence still awaits acknowledgement", async () => {
  const database = await temporaryDatabase()
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const input = yield* classifiedVoiceInput()
        const release = yield* Deferred.make<void>()
        const entered = yield* Deferred.make<void>()
        const succeeded = yield* Queue.unbounded<void>()
        const transport = voiceTransportFixture()
        const conversation = replyLayer(database.path, fakeAnswerLayer(0))
        const intercepted = Layer.effect(
          Conversation,
          Effect.gen(function* () {
            const real = yield* Conversation
            return Conversation.of({
              ...real,
              fenceSpeech: (request) =>
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(real.fenceSpeech(request))
                )
            })
          })
        ).pipe(Layer.provide(conversation))
        const recognition = fakeRecognitionLayer({
          languages: ["ru", "fr", "en"],
          scripts: ["A", "B"].map((text) => ({
            events: [{ kind: "Final", text, spans: [{ start: 0, end: 1, language: "en" }], detectedLanguage: "en" }],
            delayMillis: 0,
            failure: null
          }))
        })
        const application = Voice.configuredLayer.pipe(
          Layer.provide(
            Layer.mergeAll(
              intercepted,
              transport.layer,
              recognition,
              fakeSynthesisLayer(),
              input.layer,
              voiceAdmissionsFixture().pipe(Layer.provide(conversation)),
              Layer.succeed(VoiceLanguageConfiguration, defaultVoiceLanguageConfiguration),
              Layer.succeed(VoiceOutputConfiguration, defaultVoiceOutputSettings),
              Layer.succeed(VoiceDiagnostics, {
                record(record) {
                  if (record.cause === "recognitionSucceeded") Queue.offerUnsafe(succeeded, undefined)
                }
              })
            )
          ),
          Layer.provideMerge(conversation)
        )
        yield* Effect.gen(function* () {
          const voice = yield* Voice
          const durable = yield* Conversation
          const join = yield* voice.start(startVoiceRequest())
          yield* input.segment(transport)
          yield* Deferred.await(entered).pipe(Effect.timeout("2 seconds"))
          yield* Queue.take(succeeded).pipe(Effect.timeout("2 seconds"))
          expect((yield* durable.page({ limit: 100 })).messages).toEqual([])
          yield* input.segment(transport)
          yield* Queue.take(succeeded).pipe(Effect.timeout("2 seconds"))
          expect((yield* durable.page({ limit: 100 })).messages).toEqual([])
          expect((yield* voice.snapshot(join.sessionId, 0)).events.filter((event) => event.kind === "Final")).toEqual(
            []
          )
          yield* Deferred.succeed(release, undefined)
          let page = yield* durable.page({ limit: 100 })
          for (let attempt = 0; !page.messages.some((message) => message.role === "user") && attempt < 200; attempt++) {
            yield* Effect.sleep(5)
            page = yield* durable.page({ limit: 100 })
          }
          expect(page.messages.filter((message) => message.role === "user").map((message) => message.text)).toEqual([
            "A B"
          ])
          expect(page.messages.find((message) => message.role === "user")?.languageSpans).toEqual([
            { start: 0, end: 1, language: "en" },
            { start: 2, end: 3, language: "en" }
          ])
          yield* voice.end(join.sessionId)
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)), Effect.scoped, Effect.provide(application))
      })
    )
  } finally {
    await database.close()
  }
})
