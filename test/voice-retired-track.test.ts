import { Deferred, Effect, Layer, Stream, Queue } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { SpeechRecognition, fakeRecognitionLayer } from "../src/speech-recognition/index.ts"
import { fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import {
  Voice,
  SpeechActivity,
  fakeSpeechActivityLayer,
  defaultVoiceLanguageConfiguration,
  defaultVoiceOutputSettings
} from "../src/voice/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { voiceTransportFixture } from "./voice-fixture.ts"
import { voiceOutputLayer } from "./voice-output-fixture.ts"
import { startVoiceRequest } from "./voice-admission-fixture.ts"

it("keeps replacement-track speech intact when the retired track sends late PCM", async () => {
  const database = await temporaryDatabase()
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const classified = yield* Queue.unbounded<number>()
        const recognized = yield* Deferred.make<readonly number[]>()
        const transport = voiceTransportFixture()
        const activity = Layer.effect(
          SpeechActivity,
          Effect.gen(function* () {
            const real = yield* SpeechActivity
            return SpeechActivity.of({
              open: () =>
                real
                  .open()
                  .pipe(
                    Effect.map((stream) => ({
                      reset: () => stream.reset(),
                      push: (frame) =>
                        stream.push(frame).pipe(Effect.tap(() => Queue.offer(classified, frame.data[0] ?? 0)))
                    }))
                  )
            })
          })
        ).pipe(Layer.provide(fakeSpeechActivityLayer))
        const recognition = Layer.effect(
          SpeechRecognition,
          Effect.gen(function* () {
            const real = yield* SpeechRecognition
            return SpeechRecognition.of({
              ...real,
              recognize: (request) => {
                const data = new DataView(
                  request.audio.bytes.buffer,
                  request.audio.bytes.byteOffset,
                  request.audio.bytes.byteLength
                )
                const prefix = [0, 320, 640].map((index) => data.getInt16(index * 2, true))
                return Stream.fromEffect(Deferred.succeed(recognized, prefix)).pipe(
                  Stream.flatMap(() => real.recognize(request))
                )
              }
            })
          })
        ).pipe(
          Layer.provide(
            fakeRecognitionLayer({
              languages: ["ru", "fr", "en"],
              scripts: [
                {
                  events: [{ kind: "Final", text: "Replacement track speech", spans: [] }],
                  delayMillis: 0,
                  failure: null
                }
              ]
            })
          )
        )
        yield* Effect.gen(function* () {
          const voice = yield* Voice
          const conversation = yield* Conversation
          const sendClassified = (sample: number, track: string) =>
            Effect.gen(function* () {
              yield* transport.send(transport.audio(sample), track)
              expect(yield* Queue.take(classified).pipe(Effect.timeout("2 seconds"))).toBe(sample)
            })
          const joined = yield* voice.start(startVoiceRequest())
          yield* sendClassified(1200, "track-A")
          yield* sendClassified(1300, "track-B")
          yield* transport.send(transport.audio(9000), "track-A")
          yield* sendClassified(1400, "track-B")
          yield* sendClassified(1500, "track-B")
          for (let frame = 0; frame < 50; frame++) yield* sendClassified(0, "track-B")
          expect(yield* Deferred.await(recognized).pipe(Effect.timeout("2 seconds"))).toEqual([1300, 1400, 1500])
          let page = yield* conversation.page({ limit: 100 })
          for (let attempt = 0; !page.messages.some((message) => message.role === "user") && attempt < 300; attempt++) {
            yield* Effect.sleep(5)
            page = yield* conversation.page({ limit: 100 })
          }
          expect(page.messages.filter((message) => message.role === "user").map((message) => message.text)).toEqual([
            "Replacement track speech"
          ])
          expect(
            (yield* voice.snapshot(joined.sessionId, 0)).events.filter((event) => event.kind === "Accepted")
          ).toHaveLength(1)
          yield* voice.end(joined.sessionId)
        }).pipe(
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
