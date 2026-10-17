import { Deferred, Effect, Fiber, Layer } from "effect"
import { expect, it } from "vitest"
import { Conversation, StorageUnavailable } from "../src/conversation/index.ts"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { fakeRecognitionLayer } from "../src/speech-recognition/index.ts"
import { fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import { Voice, VoiceTransport } from "../src/voice/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { replyLayer } from "./reply-fixture.ts"
import { startVoiceRequest, voiceAdmissionsFixture } from "./voice-admission-fixture.ts"
import { voiceTransportFixture } from "./voice-fixture.ts"
import { outputInput, waitForOutput } from "./voice-output-fixture.ts"

it.each(["delivery unregistration", "publication close"])(
  "retries failed %s and waits for its acknowledgment before ending",
  async (releasePort) => {
    const database = await temporaryDatabase()
    const transport = voiceTransportFixture()
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const retryEntered = yield* Deferred.make<void>()
          const acknowledge = yield* Deferred.make<void>()
          const acknowledged = yield* Deferred.make<void>()
          const conversation = replyLayer(database.path, fakeAnswerLayer(0))
          let attempts = 0
          const decorated = Layer.effect(
            Conversation,
            Effect.gen(function* () {
              const real = yield* Conversation
              return Conversation.of({
                ...real,
                unregisterReplyDelivery: (registrationId) =>
                  Effect.suspend(() => {
                    if (releasePort !== "delivery unregistration") return real.unregisterReplyDelivery(registrationId)
                    attempts += 1
                    if (attempts === 1)
                      return Effect.fail(new StorageUnavailable({ message: "First unregister failed" }))
                    return Deferred.succeed(retryEntered, undefined).pipe(
                      Effect.andThen(Deferred.await(acknowledge)),
                      Effect.andThen(real.unregisterReplyDelivery(registrationId)),
                      Effect.tap(() => Deferred.succeed(acknowledged, undefined))
                    )
                  })
              })
            })
          ).pipe(Layer.provide(conversation))
          const observedTransport = Layer.effect(
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
                          opened.connection.openOutput(...outputArgs).pipe(
                            Effect.map((publication) => ({
                              ...publication,
                              close: () =>
                                Effect.suspend(() => {
                                  if (releasePort !== "publication close") return publication.close()
                                  attempts += 1
                                  if (attempts === 1) return Effect.die(new Error("First publication close failed"))
                                  return Deferred.succeed(retryEntered, undefined).pipe(
                                    Effect.andThen(Deferred.await(acknowledge)),
                                    Effect.andThen(publication.close()),
                                    Effect.tap(() => Deferred.succeed(acknowledged, undefined))
                                  )
                                })
                            }))
                          )
                      }
                    }))
                  )
              })
            })
          ).pipe(Layer.provide(transport.layer))
          const application = Voice.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                decorated,
                observedTransport,
                fakeRecognitionLayer(),
                fakeSynthesisLayer({ delayMillis: 0 }),
                voiceAdmissionsFixture().pipe(Layer.provide(conversation))
              )
            ),
            Layer.provideMerge(conversation)
          )
          yield* Effect.gen(function* () {
            const voice = yield* Voice
            const durable = yield* Conversation
            const first = yield* voice.start(startVoiceRequest())
            yield* durable.send(outputInput)
            expect((yield* waitForOutput(voice, first.sessionId, "AwaitingReady")).output?.status).toBe("AwaitingReady")
            const ending = yield* voice.end(first.sessionId).pipe(Effect.forkIn(yield* Effect.scope))
            yield* Deferred.await(retryEntered).pipe(Effect.timeout("2 seconds"))
            expect(attempts).toBe(2)
            expect(ending.pollUnsafe()).toBeUndefined()
            expect((yield* voice.snapshot(first.sessionId, 0)).status).toBe("ended")
            expect(transport.publications[0]?.invalidated).toBe(true)
            if (releasePort === "publication close") expect(transport.publications[0]?.closed).toBe(false)
            yield* Deferred.succeed(acknowledge, undefined)
            yield* Deferred.await(acknowledged).pipe(Effect.timeout("2 seconds"))
            yield* Fiber.join(ending).pipe(Effect.timeout("2 seconds"))
            expect(transport.publications[0]?.closed).toBe(true)
            const second = yield* voice.start(startVoiceRequest())
            expect(second.sessionId).not.toBe(first.sessionId)
            const fresh = yield* durable.send({ deliveryId: crypto.randomUUID(), text: "Fresh after release recovery" })
            const next = (yield* waitForOutput(voice, second.sessionId, "AwaitingReady")).output
            if (next?.manifest == null) throw new Error("Missing fresh publication")
            yield* voice.ready(second.sessionId, {
              responseId: next.responseId,
              outputEpoch: next.outputEpoch,
              trackSid: next.manifest.trackSid
            })
            expect((yield* waitForOutput(voice, second.sessionId, "Delivered")).output?.status).toBe("Delivered")
            expect((yield* durable.reply(fresh.deliveryId)).receipt?.outcome).toBe("completed")
          }).pipe(Effect.ensuring(Deferred.succeed(acknowledge, undefined)), Effect.scoped, Effect.provide(application))
        })
      )
    } finally {
      await database.close()
    }
  }
)
