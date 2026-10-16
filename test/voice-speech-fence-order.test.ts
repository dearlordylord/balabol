import { Deferred, Effect, Layer, Queue, Stream } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { SpeechRecognition, fakeRecognitionLayer } from "../src/speech-recognition/index.ts"
import { fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import {
  Voice,
  SpeechActivity,
  fakeSpeechActivityLayer,
  VoiceLanguageConfiguration,
  defaultVoiceLanguageConfiguration,
  VoiceOutputConfiguration,
  defaultVoiceOutputSettings
} from "../src/voice/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { replyLayer } from "./reply-fixture.ts"
import { voiceTransportFixture } from "./voice-fixture.ts"
import { startVoiceRequest, voiceAdmissionsFixture } from "./voice-admission-fixture.ts"

it("keeps newer speech eligible when an older held fence is rejected out of order", async () => {
  const database = await temporaryDatabase()
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const firstFence = yield* Deferred.make<void>()
        const releaseFirst = yield* Deferred.make<void>()
        const firstRejected = yield* Deferred.make<string>()
        const secondApplied = yield* Deferred.make<void>()
        const firstRecognized = yield* Deferred.make<void>()
        const classified = yield* Queue.unbounded<number>()
        const transport = voiceTransportFixture()
        const conversation = replyLayer(database.path, fakeAnswerLayer(0))
        const fenced = Layer.effect(
          Conversation,
          Effect.gen(function* () {
            const real = yield* Conversation
            return Conversation.of({
              ...real,
              fenceSpeech: (input) =>
                input.sequence === 1
                  ? Deferred.succeed(firstFence, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseFirst)),
                      Effect.andThen(real.fenceSpeech(input)),
                      Effect.tapError((error) => Deferred.succeed(firstRejected, error._tag))
                    )
                  : real.fenceSpeech(input).pipe(Effect.tap(() => Deferred.succeed(secondApplied, undefined)))
            })
          })
        ).pipe(Layer.provide(conversation))
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
                const sample = new DataView(request.audio.bytes.buffer, request.audio.bytes.byteOffset).getInt16(
                  0,
                  true
                )
                expect([1200, 2400]).toContain(sample)
                return Stream.succeed({
                  utteranceId: request.utteranceId,
                  kind: "Final" as const,
                  text: sample === 1200 ? "older held turn" : "newer valid turn",
                  spans: []
                }).pipe(Stream.ensuring(sample === 1200 ? Deferred.succeed(firstRecognized, undefined) : Effect.void))
              }
            })
          })
        ).pipe(Layer.provide(fakeRecognitionLayer()))
        const application = Voice.configuredLayer.pipe(
          Layer.provide(
            Layer.mergeAll(
              fenced,
              transport.layer,
              recognition,
              activity,
              fakeSynthesisLayer(),
              Layer.succeed(VoiceLanguageConfiguration, defaultVoiceLanguageConfiguration),
              Layer.succeed(VoiceOutputConfiguration, defaultVoiceOutputSettings),
              voiceAdmissionsFixture().pipe(Layer.provide(conversation))
            )
          ),
          Layer.provideMerge(conversation)
        )
        yield* Effect.gen(function* () {
          const voice = yield* Voice
          const durable = yield* Conversation
          const joined = yield* voice.start(startVoiceRequest())
          const sendClassified = (sample: number) =>
            Effect.gen(function* () {
              yield* transport.send(transport.audio(sample))
              expect(yield* Queue.take(classified).pipe(Effect.timeout("2 seconds"))).toBe(sample)
            })
          for (let frame = 0; frame < 3; frame++) yield* sendClassified(1200)
          yield* Deferred.await(firstFence).pipe(Effect.timeout("2 seconds"))
          for (let frame = 0; frame < 50; frame++) yield* sendClassified(0)
          yield* Deferred.await(firstRecognized).pipe(Effect.timeout("2 seconds"))
          expect((yield* durable.page({ limit: 100 })).messages).toEqual([])
          expect(
            (yield* voice.snapshot(joined.sessionId, 0)).events.filter((event) => event.kind === "Accepted")
          ).toEqual([])
          for (let frame = 0; frame < 3; frame++) yield* sendClassified(2400)
          yield* Deferred.await(secondApplied).pipe(Effect.timeout("2 seconds"))
          yield* Deferred.succeed(releaseFirst, undefined)
          expect(yield* Deferred.await(firstRejected).pipe(Effect.timeout("2 seconds"))).toBe("InvalidInput")
          yield* sendClassified(2400)
          for (let frame = 0; frame < 50; frame++) yield* sendClassified(0)
          let page = yield* durable.page({ limit: 100 })
          for (let poll = 0; !page.messages.some((message) => message.role === "user") && poll < 300; poll++) {
            yield* Effect.sleep(5)
            page = yield* durable.page({ limit: 100 })
          }
          expect(page.messages.filter((message) => message.role === "user").map((message) => message.text)).toEqual([
            "newer valid turn"
          ])
          const snapshot = yield* voice.snapshot(joined.sessionId, 0)
          expect(snapshot.status).toBe("active")
          expect(snapshot.events.filter((event) => event.kind === "Error")).toEqual([])
          expect(
            snapshot.events.filter((event) => event.kind === "Accepted").map((event) => event.receipt.text)
          ).toEqual(["newer valid turn"])
          yield* voice.end(joined.sessionId)
        }).pipe(Effect.ensuring(Deferred.succeed(releaseFirst, undefined)), Effect.scoped, Effect.provide(application))
      })
    )
  } finally {
    await database.close()
  }
})
