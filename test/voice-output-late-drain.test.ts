import { it } from "@effect/vitest"
import { Deferred, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vitest"
import { fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import { Conversation } from "../src/conversation/index.ts"
import { Voice, VoiceTransport } from "../src/voice/index.ts"
import { startVoiceRequest } from "./voice-admission-fixture.ts"
import { voiceTransportFixture } from "./voice-fixture.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { outputInput, voiceOutputLayer } from "./voice-output-fixture.ts"

it.effect("a late successful drain cannot revive an expired delivery and a fresh reply still delivers", () =>
  Effect.gen(function* () {
    const database = yield* Effect.promise(temporaryDatabase)
    yield* Effect.addFinalizer(() => Effect.promise(database.close))
    const transport = voiceTransportFixture()
    const draining = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const closed = yield* Deferred.make<void>()
    const freshClosed = yield* Deferred.make<void>()
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
                  openOutput: (...outputArgs) =>
                    opened.connection.openOutput(...outputArgs).pipe(
                      Effect.map((publication) => {
                        publications += 1
                        if (publications !== 1)
                          return {
                            ...publication,
                            close: () =>
                              publication.close().pipe(Effect.ensuring(Deferred.succeed(freshClosed, undefined)))
                          }
                        return {
                          ...publication,
                          drain: () =>
                            publication
                              .drain()
                              .pipe(
                                Effect.andThen(Deferred.succeed(draining, undefined)),
                                Effect.andThen(Deferred.await(release)),
                                Effect.uninterruptible
                              ),
                          close: () => publication.close().pipe(Effect.ensuring(Deferred.succeed(closed, undefined)))
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
      const join = yield* voice.start(startVoiceRequest())
      yield* conversation.send(outputInput)
      yield* TestClock.adjust(1)
      const first = (yield* voice.snapshot(join.sessionId, 0)).output
      if (first?.manifest == null) throw new Error("Missing first publication")
      yield* voice.ready(join.sessionId, {
        responseId: first.responseId,
        outputEpoch: first.outputEpoch,
        trackSid: first.manifest.trackSid
      })
      yield* TestClock.adjust(1)
      yield* Deferred.await(draining)
      expect(transport.captured.length).toBeGreaterThan(0)
      yield* TestClock.adjust(20000)
      expect((yield* voice.snapshot(join.sessionId, 0)).status).toBe("active")
      yield* TestClock.adjust(11000)
      const expired = yield* voice.snapshot(join.sessionId, 0)
      expect(expired.output?.status).toBe("Failed")
      expect(expired.output?.error?.code).toBe("AudioUnavailable")
      expect(transport.publications[0]?.invalidated).toBe(true)
      expect((yield* conversation.reply(outputInput.deliveryId)).receipt?.outcome).toBe("interrupted")
      yield* Deferred.succeed(release, undefined)
      yield* Deferred.await(closed)
      expect((yield* conversation.reply(outputInput.deliveryId)).state).toBe("Interrupted")
      const fresh = { deliveryId: "22222222-2222-4222-8222-222222222222", text: "Fresh reply" }
      yield* conversation.send(fresh)
      yield* TestClock.adjust(1)
      const next = (yield* voice.snapshot(join.sessionId, 0)).output
      if (next?.manifest == null) throw new Error("Missing fresh publication")
      expect(next.outputEpoch).not.toBe(first.outputEpoch)
      expect(next.status).toBe("AwaitingReady")
      yield* voice.ready(join.sessionId, {
        responseId: next.responseId,
        outputEpoch: next.outputEpoch,
        trackSid: next.manifest.trackSid
      })
      yield* TestClock.adjust(1)
      yield* Deferred.await(freshClosed)
      // Publish the settled output through the independent session projection pump.
      yield* TestClock.adjust(20)
      expect((yield* voice.snapshot(join.sessionId, 0)).output?.status).toBe("Delivered")
      expect((yield* conversation.reply(fresh.deliveryId)).receipt?.outcome).toBe("completed")
      expect((yield* conversation.reply(outputInput.deliveryId)).receipt?.outcome).toBe("interrupted")
      expect((yield* conversation.page({ limit: 100 })).messages).toHaveLength(4)
    }).pipe(
      Effect.ensuring(Deferred.succeed(release, undefined)),
      Effect.provide(voiceOutputLayer(database.path, { ...transport, layer }, fakeSynthesisLayer({ delayMillis: 0 })))
    )
  })
)
