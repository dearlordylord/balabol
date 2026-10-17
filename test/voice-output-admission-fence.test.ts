import { Deferred, Effect, Layer } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import { fakeRecognitionLayer } from "../src/speech-recognition/index.ts"
import {
  Voice,
  VoiceAdmissions,
  VoiceLanguageConfiguration,
  VoiceOutputConfiguration,
  defaultVoiceLanguageConfiguration,
  defaultVoiceOutputSettings
} from "../src/voice/index.ts"
import { voiceTransportFixture } from "./voice-fixture.ts"
import { replyLayer, waitForReply } from "./reply-fixture.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { classifiedVoiceInput, waitForOutput } from "./voice-output-fixture.ts"
import { startVoiceRequest, voiceAdmissionsFixture } from "./voice-admission-fixture.ts"

it("retains a stalled admission fence across later admission retirement and fresh speech", async () => {
  const database = await temporaryDatabase()
  const transport = voiceTransportFixture()
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const input = yield* classifiedVoiceInput()
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const returned = yield* Deferred.make<void>()
        let stalledId = ""
        const conversation = replyLayer(database.path, fakeAnswerLayer(0))
        const admissions = Layer.effect(
          VoiceAdmissions,
          Effect.gen(function* () {
            const real = yield* VoiceAdmissions
            return VoiceAdmissions.of({
              ...real,
              begin: (reservation) =>
                reservation.text === "stalled"
                  ? Effect.gen(function* () {
                      stalledId = reservation.deliveryId
                      yield* Deferred.succeed(entered, undefined)
                      yield* Deferred.await(release)
                      yield* real.begin(reservation)
                      yield* Deferred.succeed(returned, undefined)
                    })
                  : real.begin(reservation)
            })
          })
        ).pipe(Layer.provide(voiceAdmissionsFixture().pipe(Layer.provide(conversation))))
        const application = Voice.configuredLayer.pipe(
          Layer.provide(
            Layer.mergeAll(
              input.layer,
              Layer.succeed(VoiceLanguageConfiguration, defaultVoiceLanguageConfiguration),
              Layer.succeed(VoiceOutputConfiguration, defaultVoiceOutputSettings),
              conversation,
              admissions,
              transport.layer,
              fakeSynthesisLayer({ delayMillis: 0 }),
              fakeRecognitionLayer({
                languages: ["en", "fr", "ru"],
                scripts: ["stalled", "retired", ""].map((text) => ({
                  events: [{ kind: "Final", text, spans: [] }],
                  delayMillis: 0,
                  failure: null
                }))
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
          yield* input.segment(transport)
          let snapshot = yield* voice.snapshot(join.sessionId, 0)
          for (let index = 0; !snapshot.events.some((event) => event.kind === "Accepted") && index < 200; index++) {
            yield* Effect.sleep(5)
            snapshot = yield* voice.snapshot(join.sessionId, 0)
          }
          expect(snapshot.events.some((event) => event.kind === "Accepted")).toBe(true)
          yield* input.segment(transport)
          yield* Deferred.succeed(release, undefined)
          yield* Deferred.await(returned).pipe(Effect.timeout("2 seconds"))
          for (
            let index = 0;
            !snapshot.events.some((event) => event.kind === "Accepted" && event.receipt.deliveryId === stalledId) &&
            index < 200;
            index++
          ) {
            yield* Effect.sleep(5)
            snapshot = yield* voice.snapshot(join.sessionId, 0)
          }
          expect(
            snapshot.events.some((event) => event.kind === "Accepted" && event.receipt.deliveryId === stalledId)
          ).toBe(true)
          expect((yield* waitForReply(durable, stalledId)).receipt?.outcome).toBe("interrupted")
          snapshot = yield* voice.snapshot(join.sessionId, 0)
          expect(
            snapshot.events.some(
              (event) =>
                event.kind === "Output" && event.output.inputDeliveryId === stalledId && event.output.manifest !== null
            )
          ).toBe(false)
          expect(transport.captured).toEqual([])
          const fresh = yield* durable.send({ deliveryId: crypto.randomUUID(), text: "Fresh reply" })
          const ready = (yield* waitForOutput(voice, join.sessionId, "AwaitingReady")).output
          if (ready?.manifest == null) throw new Error("Missing fresh publication")
          expect(ready.inputDeliveryId).toBe(fresh.deliveryId)
          yield* voice.ready(join.sessionId, {
            responseId: ready.responseId,
            outputEpoch: ready.outputEpoch,
            trackSid: ready.manifest.trackSid
          })
          expect((yield* waitForOutput(voice, join.sessionId, "Delivered")).output?.status).toBe("Delivered")
          expect(transport.captured.every((audio) => audio.outputEpoch === ready.outputEpoch)).toBe(true)
          expect(transport.captured.length).toBeGreaterThan(0)
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)), Effect.scoped, Effect.provide(application))
      })
    )
  } finally {
    await database.close()
  }
})
