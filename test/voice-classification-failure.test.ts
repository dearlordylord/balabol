import { Deferred, Effect, Layer, Queue } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { fakeRecognitionLayer } from "../src/speech-recognition/index.ts"
import { fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import {
  Voice,
  VoiceFailed,
  SpeechActivity,
  fakeSpeechActivityLayer,
  defaultVoiceLanguageConfiguration,
  defaultVoiceOutputSettings
} from "../src/voice/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { voiceTransportFixture } from "./voice-fixture.ts"
import { voiceOutputLayer } from "./voice-output-fixture.ts"
import { startVoiceRequest } from "./voice-admission-fixture.ts"

it("ignores a classifier failure from before mute and admits fresh speech after resume", async () => {
  const database = await temporaryDatabase()
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const classified = yield* Queue.unbounded<number>()
        const transport = voiceTransportFixture()
        const activity = Layer.effect(
          SpeechActivity,
          Effect.gen(function* () {
            const real = yield* SpeechActivity
            return SpeechActivity.of({
              open: () =>
                real.open().pipe(
                  Effect.map((stream) => {
                    let first = true
                    return {
                      reset: () => stream.reset(),
                      push: (frame) =>
                        Effect.suspend(() => {
                          if (!first)
                            return stream
                              .push(frame)
                              .pipe(Effect.tap(() => Queue.offer(classified, frame.data[0] ?? 0)))
                          first = false
                          return Deferred.succeed(entered, undefined).pipe(
                            Effect.andThen(Deferred.await(release)),
                            Effect.andThen(
                              Effect.fail(new VoiceFailed({ code: "InvalidAudio", message: "Old classifier failure" }))
                            )
                          )
                        })
                    }
                  })
                )
            })
          })
        ).pipe(Layer.provide(fakeSpeechActivityLayer))
        const recognition = fakeRecognitionLayer({
          languages: ["ru", "fr", "en"],
          scripts: [
            { events: [{ kind: "Final", text: "Fresh recognized speech", spans: [] }], delayMillis: 0, failure: null }
          ]
        })
        yield* Effect.gen(function* () {
          const voice = yield* Voice
          const conversation = yield* Conversation
          const sendClassified = (sample: number) =>
            Effect.gen(function* () {
              yield* transport.send(transport.audio(sample))
              expect(yield* Queue.take(classified).pipe(Effect.timeout("2 seconds"))).toBe(sample)
            })
          const joined = yield* voice.start(startVoiceRequest())
          yield* transport.send(transport.audio(1200))
          yield* Deferred.await(entered).pipe(Effect.timeout("2 seconds"))
          yield* voice.mute(joined.sessionId, true)
          yield* voice.mute(joined.sessionId, false)
          yield* Deferred.succeed(release, undefined)
          yield* sendClassified(1300)
          const resumed = yield* voice.snapshot(joined.sessionId, 0)
          expect(resumed.status).toBe("active")
          expect(resumed.muted).toBe(false)
          expect(resumed.events.filter((event) => event.kind === "Error")).toEqual([])
          yield* sendClassified(1300)
          yield* sendClassified(1300)
          for (let frame = 0; frame < 50; frame++) yield* sendClassified(0)
          let page = yield* conversation.page({ limit: 100 })
          for (let attempt = 0; !page.messages.some((message) => message.role === "user") && attempt < 300; attempt++) {
            yield* Effect.sleep(5)
            page = yield* conversation.page({ limit: 100 })
          }
          expect(page.messages.filter((message) => message.role === "user").map((message) => message.text)).toEqual([
            "Fresh recognized speech"
          ])
          const snapshot = yield* voice.snapshot(joined.sessionId, 0)
          expect(snapshot.events.filter((event) => event.kind === "Error")).toEqual([])
          expect(snapshot.events.filter((event) => event.kind === "Accepted")).toHaveLength(1)
          yield* voice.end(joined.sessionId)
        }).pipe(
          Effect.ensuring(Deferred.succeed(release, undefined)),
          Effect.scoped,
          Effect.provide(
            voiceOutputLayer(
              database.path,
              transport,
              fakeSynthesisLayer(),
              fakeAnswerLayer(0),
              recognition,
              defaultVoiceLanguageConfiguration,
              defaultVoiceOutputSettings,
              activity
            )
          )
        )
      })
    )
  } finally {
    await database.close()
  }
})
