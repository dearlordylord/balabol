import { Deferred, Effect, Layer, Stream } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import { fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { fakeRecognitionLayer } from "../src/speech-recognition/index.ts"
import { Voice, VoiceTransport } from "../src/voice/index.ts"
import { replyLayer } from "./reply-fixture.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { voiceTransportFixture } from "./voice-fixture.ts"
import { startVoiceRequest, voiceAdmissionsFixture } from "./voice-admission-fixture.ts"
import { outputInput, voiceOutputLayer, waitForOutput } from "./voice-output-fixture.ts"
const identity = "11111111-1111-4111-8111-111111111111"

it("projects coalesced invalidation without starting publication when Started was never observed", async () => {
  const database = await temporaryDatabase()
  const transport = voiceTransportFixture()
  const conversation = replyLayer(database.path, fakeAnswerLayer(0))
  const observed = Layer.effect(
    Conversation,
    Effect.gen(function* () {
      const real = yield* Conversation
      return Conversation.of({
        ...real,
        registerReplyDelivery: (input) =>
          real
            .registerReplyDelivery(input)
            .pipe(
              Effect.map((registration) => ({
                ...registration,
                snapshot: {
                  kind: "Invalidated" as const,
                  registrationId: registration.registrationId,
                  sequence: registration.snapshot.sequence + 2,
                  ticket: {
                    registrationId: registration.registrationId,
                    deliveryId: identity,
                    inputDeliveryId: identity,
                    responseId: identity,
                    deadlineAt: 60000
                  },
                  reason: "Interrupted" as const
                },
                updates: Stream.empty
              }))
            )
      })
    })
  ).pipe(Layer.provide(conversation))
  const application = Voice.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        observed,
        transport.layer,
        fakeSynthesisLayer(),
        fakeRecognitionLayer(),
        voiceAdmissionsFixture().pipe(Layer.provide(conversation))
      )
    )
  )
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const voice = yield* Voice
        const join = yield* voice.start(startVoiceRequest())
        const snapshot = yield* voice.snapshot(join.sessionId, 0)
        expect(snapshot.output?.status).toBe("Interrupted")
        expect(snapshot.output?.responseId).toBe(identity)
        expect(transport.publications).toEqual([])
        yield* voice.end(join.sessionId)
      }).pipe(Effect.scoped, Effect.provide(application))
    )
  } finally {
    await database.close()
  }
})

it("closes publication acquired after revocation without exposing readiness and delivers a fresh reply", async () => {
  const database = await temporaryDatabase()
  const transport = voiceTransportFixture()
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const closed = yield* Deferred.make<void>()
        let acquisitions = 0
        const layer = Layer.effect(
          VoiceTransport,
          Effect.gen(function* () {
            const real = yield* VoiceTransport
            return VoiceTransport.of({
              open: (...args) =>
                real.open(...args).pipe(
                  Effect.map((opened) => ({
                    ...opened,
                    connection: {
                      ...opened.connection,
                      openOutput: (...outputArgs) =>
                        Effect.suspend(() => {
                          acquisitions += 1
                          if (acquisitions !== 1) return opened.connection.openOutput(...outputArgs)
                          return opened.connection.openOutput(...outputArgs).pipe(
                            Effect.map((publication) => ({
                              ...publication,
                              close: () =>
                                publication.close().pipe(Effect.ensuring(Deferred.succeed(closed, undefined)))
                            })),
                            Effect.tap(() => Deferred.succeed(entered, undefined)),
                            Effect.tap(() => Deferred.await(release)),
                            Effect.uninterruptible
                          )
                        })
                    }
                  }))
                )
            })
          })
        ).pipe(Layer.provide(transport.layer))
        yield* Effect.gen(function* () {
          const voice = yield* Voice
          const conversation = yield* Conversation
          const join = yield* voice.start(startVoiceRequest())
          yield* conversation.send(outputInput)
          yield* Deferred.await(entered).pipe(Effect.timeout("2 seconds"))
          const first = yield* conversation.reply(outputInput.deliveryId)
          yield* conversation.interruptResponse({
            inputDeliveryId: outputInput.deliveryId,
            responseId: first.responseId
          })
          expect(transport.publications[0]?.invalidated).toBe(true)
          yield* Deferred.succeed(release, undefined)
          yield* Deferred.await(closed).pipe(Effect.timeout("2 seconds"))
          expect(transport.publications[0]?.closed).toBe(true)
          expect((yield* voice.snapshot(join.sessionId, 0)).output?.manifest).toBeNull()
          expect(transport.captured).toEqual([])
          const fresh = { deliveryId: crypto.randomUUID(), text: "A fresh publication" }
          yield* conversation.send(fresh)
          const next = (yield* waitForOutput(voice, join.sessionId, "AwaitingReady")).output
          if (next?.manifest == null) throw new Error("Missing fresh publication")
          yield* voice.ready(join.sessionId, {
            responseId: next.responseId,
            outputEpoch: next.outputEpoch,
            trackSid: next.manifest.trackSid
          })
          expect((yield* waitForOutput(voice, join.sessionId, "Delivered")).output?.status).toBe("Delivered")
          expect((yield* conversation.reply(fresh.deliveryId)).receipt?.outcome).toBe("completed")
          expect(transport.captured.every((audio) => audio.outputEpoch === next.outputEpoch)).toBe(true)
        }).pipe(
          Effect.ensuring(Deferred.succeed(release, undefined)),
          Effect.scoped,
          Effect.provide(voiceOutputLayer(database.path, { ...transport, layer }))
        )
      })
    )
  } finally {
    await database.close()
  }
})
