import { Deferred, Effect, Layer, Stream } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { fakeRecognitionLayer } from "../src/speech-recognition/index.ts"
import { fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import {
  Voice,
  VoiceAdmissions,
  VoiceLanguageConfiguration,
  VoiceOutputConfiguration,
  defaultVoiceLanguageConfiguration,
  defaultVoiceOutputSettings
} from "../src/voice/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { replyLayer } from "./reply-fixture.ts"
import { startVoiceRequest, voiceAdmissionsFixture } from "./voice-admission-fixture.ts"
import { voiceTransportFixture } from "./voice-fixture.ts"
import { classifiedVoiceInput, waitForOutput } from "./voice-output-fixture.ts"

it("keeps a finished handed admission fenced while its newer speech fence and Started notification are delayed", async () => {
  const database = await temporaryDatabase()
  const transport = voiceTransportFixture()
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const input = yield* classifiedVoiceInput()
        const handed = yield* Deferred.make<void>()
        const submit = yield* Deferred.make<void>()
        const fenced = yield* Deferred.make<void>()
        const applyFence = yield* Deferred.make<void>()
        const fenceApplied = yield* Deferred.make<void>()
        const started = yield* Deferred.make<void>()
        const notify = yield* Deferred.make<void>()
        const sealed = yield* Deferred.make<void>()
        let admissionId = ""
        let fences = 0
        let starts = 0
        const conversation = replyLayer(database.path, fakeAnswerLayer(0))
        const observed = Layer.effect(
          Conversation,
          Effect.gen(function* () {
            const real = yield* Conversation
            return Conversation.of({
              ...real,
              submitInput: (reservation) =>
                Effect.gen(function* () {
                  admissionId = reservation.deliveryId
                  yield* Deferred.succeed(handed, undefined)
                  yield* Deferred.await(submit)
                  return yield* real.submitInput(reservation)
                }),
              fenceSpeech: (request) =>
                Effect.suspend(() => {
                  fences += 1
                  return fences === 2
                    ? Deferred.succeed(fenced, undefined).pipe(
                        Effect.andThen(Deferred.await(applyFence)),
                        Effect.andThen(real.fenceSpeech(request)),
                        Effect.tap(() => Deferred.succeed(fenceApplied, undefined))
                      )
                    : real.fenceSpeech(request)
                }),
              registerReplyDelivery: (request) =>
                real.registerReplyDelivery(request).pipe(
                  Effect.map((registration) => ({
                    ...registration,
                    updates: registration.updates.pipe(
                      Stream.tap((update) =>
                        Effect.suspend(() => {
                          if (update.kind !== "Started" || starts++ !== 0) return Effect.void
                          return Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(notify)))
                        })
                      )
                    )
                  }))
                )
            })
          })
        ).pipe(Layer.provide(conversation))
        const admissions = Layer.effect(
          VoiceAdmissions,
          Effect.gen(function* () {
            const real = yield* VoiceAdmissions
            return VoiceAdmissions.of({
              ...real,
              seal: (request) => real.seal(request).pipe(Effect.tap(() => Deferred.succeed(sealed, undefined)))
            })
          })
        ).pipe(Layer.provide(voiceAdmissionsFixture().pipe(Layer.provide(conversation))))
        const application = Voice.configuredLayer.pipe(
          Layer.provide(
            Layer.mergeAll(
              observed,
              admissions,
              transport.layer,
              input.layer,
              Layer.succeed(VoiceLanguageConfiguration, defaultVoiceLanguageConfiguration),
              Layer.succeed(VoiceOutputConfiguration, defaultVoiceOutputSettings),
              fakeSynthesisLayer({ delayMillis: 0 }),
              fakeRecognitionLayer({
                languages: ["en", "fr", "ru"],
                scripts: [
                  { events: [{ kind: "Final", text: "Held handed input", spans: [] }], delayMillis: 0, failure: null }
                ]
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
          yield* Deferred.await(handed).pipe(Effect.timeout("2 seconds"))
          for (let index = 0; index < 3; index++) yield* input.send(transport, transport.audio(1200))
          yield* Deferred.await(fenced).pipe(Effect.timeout("2 seconds"))
          yield* Deferred.succeed(submit, undefined)
          yield* Deferred.await(started).pipe(Effect.timeout("2 seconds"))
          yield* Deferred.await(sealed).pipe(Effect.timeout("2 seconds"))
          const finished = yield* voice.snapshot(join.sessionId, 0)
          expect(finished.pending.some((entry) => entry.deliveryId === admissionId && entry.receipt !== null)).toBe(
            true
          )
          yield* Deferred.succeed(notify, undefined)
          const suppressed = (yield* waitForOutput(voice, join.sessionId, "Interrupted")).output
          expect(suppressed?.inputDeliveryId).toBe(admissionId)
          expect(suppressed?.status).toBe("Interrupted")
          expect(transport.publications).toEqual([])
          expect(transport.captured).toEqual([])
          yield* Deferred.succeed(applyFence, undefined)
          yield* Deferred.await(fenceApplied).pipe(Effect.timeout("2 seconds"))
          const fresh = yield* durable.send({ deliveryId: crypto.randomUUID(), text: "Fresh after applied fence" })
          const ready = (yield* waitForOutput(voice, join.sessionId, "AwaitingReady")).output
          if (ready?.manifest == null) throw new Error("Missing fresh publication")
          expect(ready.inputDeliveryId).toBe(fresh.deliveryId)
          yield* voice.ready(join.sessionId, {
            responseId: ready.responseId,
            outputEpoch: ready.outputEpoch,
            trackSid: ready.manifest.trackSid
          })
          expect((yield* waitForOutput(voice, join.sessionId, "Delivered")).output?.status).toBe("Delivered")
          expect((yield* durable.reply(fresh.deliveryId)).receipt?.outcome).toBe("completed")
        }).pipe(
          Effect.ensuring(
            Effect.all([
              Deferred.succeed(submit, undefined),
              Deferred.succeed(applyFence, undefined),
              Deferred.succeed(notify, undefined)
            ])
          ),
          Effect.scoped,
          Effect.provide(application)
        )
      })
    )
  } finally {
    await database.close()
  }
})
