import { Deferred, Effect, Layer } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import { fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import { Voice, VoiceTransport } from "../src/voice/index.ts"
import { startVoiceRequest } from "./voice-admission-fixture.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { voiceTransportFixture } from "./voice-fixture.ts"
import { outputInput, voiceOutputLayer, waitForOutput } from "./voice-output-fixture.ts"
import { waitForReply } from "./reply-fixture.ts"

it("disconnects playing audio and delivers a fresh reply in a replacement voice session", async () => {
  const database = await temporaryDatabase()
  const transport = voiceTransportFixture()
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const draining = yield* Deferred.make<void>()
        const closed = yield* Deferred.make<void>()
        const publicationClosed = yield* Deferred.make<void>()
        let publications = 0
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
                      close: () => opened.connection.close().pipe(Effect.ensuring(Deferred.succeed(closed, undefined))),
                      openOutput: (...outputArgs) =>
                        opened.connection.openOutput(...outputArgs).pipe(
                          Effect.map((publication) => {
                            publications += 1
                            if (publications !== 1) return publication
                            return {
                              ...publication,
                              close: () =>
                                publication
                                  .close()
                                  .pipe(Effect.ensuring(Deferred.succeed(publicationClosed, undefined))),
                              drain: () =>
                                publication
                                  .drain()
                                  .pipe(
                                    Effect.andThen(Deferred.succeed(draining, undefined)),
                                    Effect.andThen(Effect.never)
                                  )
                            }
                          })
                        )
                    }
                  }))
                )
            })
          })
        ).pipe(Layer.provide(transport.layer))
        yield* Effect.gen(function* () {
          const voice = yield* Voice
          const conversation = yield* Conversation
          const firstSession = yield* voice.start(startVoiceRequest())
          yield* conversation.send(outputInput)
          const first = (yield* waitForOutput(voice, firstSession.sessionId, "AwaitingReady")).output
          if (first?.manifest == null) throw new Error("Missing first publication")
          yield* voice.ready(firstSession.sessionId, {
            responseId: first.responseId,
            outputEpoch: first.outputEpoch,
            trackSid: first.manifest.trackSid
          })
          yield* Deferred.await(draining).pipe(Effect.timeout("2 seconds"))
          expect((yield* waitForOutput(voice, firstSession.sessionId, "Playing")).output?.status).toBe("Playing")
          expect(transport.captured.length).toBeGreaterThan(0)
          const oldFrames = transport.captured.filter((audio) => audio.outputEpoch === first.outputEpoch)
          transport.disconnect()
          yield* Deferred.await(closed).pipe(Effect.timeout("2 seconds"))
          expect(transport.publications[0]?.invalidated).toBe(true)
          yield* Deferred.await(publicationClosed).pipe(Effect.timeout("2 seconds"))
          expect(transport.publications[0]?.closed).toBe(true)
          expect((yield* voice.snapshot(firstSession.sessionId, 0)).status).toBe("ended")
          expect((yield* waitForReply(conversation, outputInput.deliveryId)).receipt?.outcome).toBe("interrupted")
          yield* voice.end(firstSession.sessionId)
          const secondSession = yield* voice.start(startVoiceRequest())
          expect(secondSession.sessionId).not.toBe(firstSession.sessionId)
          const fresh = yield* conversation.send({ deliveryId: crypto.randomUUID(), text: "A fresh session reply" })
          const next = (yield* waitForOutput(voice, secondSession.sessionId, "AwaitingReady")).output
          if (next?.manifest == null) throw new Error("Missing replacement publication")
          expect(next.inputDeliveryId).toBe(fresh.deliveryId)
          expect(next.outputEpoch).not.toBe(first.outputEpoch)
          yield* voice.ready(secondSession.sessionId, {
            responseId: next.responseId,
            outputEpoch: next.outputEpoch,
            trackSid: next.manifest.trackSid
          })
          expect((yield* waitForOutput(voice, secondSession.sessionId, "Delivered")).output?.status).toBe("Delivered")
          expect((yield* conversation.reply(fresh.deliveryId)).receipt?.outcome).toBe("completed")
          expect(transport.captured.filter((audio) => audio.outputEpoch === first.outputEpoch)).toEqual(oldFrames)
          expect(transport.captured.some((audio) => audio.outputEpoch === next.outputEpoch)).toBe(true)
          expect((yield* conversation.page({ limit: 100 })).messages).toHaveLength(4)
        }).pipe(
          Effect.scoped,
          Effect.provide(
            voiceOutputLayer(database.path, { ...transport, layer }, fakeSynthesisLayer({ delayMillis: 0 }))
          )
        )
      })
    )
  } finally {
    await database.close()
  }
})
