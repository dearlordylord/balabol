import { Deferred, Effect, Layer, Stream, Queue } from "effect"
import { expect, it } from "vitest"
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

it("owns callback PCM bytes before frames wait behind an asynchronous classifier", async () => {
  const database = await temporaryDatabase()
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const classified = yield* Queue.unbounded<number>()
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const recognized = yield* Deferred.make<readonly number[]>()
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
                          if (!first) return stream.push(frame)
                          first = false
                          return Deferred.succeed(entered, undefined).pipe(
                            Effect.andThen(Deferred.await(release)),
                            Effect.andThen(stream.push(frame))
                          )
                        }).pipe(Effect.tap(() => Queue.offer(classified, frame.data[0] ?? 0)))
                    }
                  })
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
                return real.recognize(request).pipe(Stream.ensuring(Deferred.succeed(recognized, prefix)))
              }
            })
          })
        ).pipe(Layer.provide(fakeRecognitionLayer()))
        yield* Effect.gen(function* () {
          const voice = yield* Voice
          const joined = yield* voice.start(startVoiceRequest())
          yield* transport.send(transport.audio(1200))
          yield* Deferred.await(entered).pipe(Effect.timeout("2 seconds"))
          const borrowed = transport.audio(1300)
          yield* transport.send(borrowed)
          borrowed.data.fill(9000)
          yield* transport.send(transport.audio(1400))
          yield* Deferred.succeed(release, undefined)
          for (const sample of [1200, 1300, 1400])
            expect(yield* Queue.take(classified).pipe(Effect.timeout("2 seconds"))).toBe(sample)
          for (let frame = 0; frame < 50; frame++) {
            yield* transport.send(transport.audio(0))
            expect(yield* Queue.take(classified).pipe(Effect.timeout("2 seconds"))).toBe(0)
          }
          expect(yield* Deferred.await(recognized).pipe(Effect.timeout("2 seconds"))).toEqual([1200, 1300, 1400])
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
