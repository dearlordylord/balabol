import { Deferred, Effect, Layer } from "effect"
import { expect, it } from "vitest"
import {
  Voice,
  VoiceTransport,
  VoiceLanguageConfiguration,
  VoiceOutputConfiguration,
  defaultVoiceLanguageConfiguration,
  defaultVoiceOutputSettings
} from "../src/voice/index.ts"
import { Conversation } from "../src/conversation/index.ts"
import { fakeRecognitionLayer } from "../src/speech-recognition/index.ts"
import { fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { replyLayer } from "./reply-fixture.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { voiceTransportFixture } from "./voice-fixture.ts"
import { classifiedVoiceInput } from "./voice-output-fixture.ts"
import { voiceAdmissionsFixture, startVoiceRequest } from "./voice-admission-fixture.ts"
it("reserves finalized speech before publication so conflicting direct text cannot take its delivery identity", async () => {
  let conflictCode: string | undefined
  const accepted = Deferred.makeUnsafe<void>()
  const database = await temporaryDatabase()
  const fixture = voiceTransportFixture()
  const capture = await Effect.runPromise(classifiedVoiceInput())
  const conversation = replyLayer(database.path, fakeAnswerLayer(0))
  const transport = Layer.effect(
    VoiceTransport,
    Effect.gen(function* () {
      const base = yield* VoiceTransport
      const durable = yield* Conversation
      return VoiceTransport.of({
        open: (...args) =>
          base.open(...args).pipe(
            Effect.map((opened) => ({
              ...opened,
              connection: {
                ...opened.connection,
                publish: (event) =>
                  event.kind === "Final"
                    ? durable.send({ deliveryId: event.deliveryId, text: "Conflicting direct text" }).pipe(
                        Effect.result,
                        Effect.tap((result) =>
                          Effect.sync(() => {
                            conflictCode = result._tag === "Failure" ? result.failure._tag : undefined
                          })
                        ),
                        Effect.asVoid
                      )
                    : opened.connection
                        .publish(event)
                        .pipe(
                          Effect.andThen(
                            event.kind === "Accepted" ? Deferred.succeed(accepted, undefined) : Effect.void
                          ),
                          Effect.asVoid
                        )
              }
            }))
          )
      })
    })
  ).pipe(Layer.provide(fixture.layer), Layer.provide(conversation))
  const admissions = voiceAdmissionsFixture().pipe(Layer.provide(conversation))
  const voice = Voice.configuredLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        conversation,
        transport,
        admissions,
        fakeRecognitionLayer(),
        fakeSynthesisLayer(),
        capture.layer,
        Layer.succeed(VoiceLanguageConfiguration, defaultVoiceLanguageConfiguration),
        Layer.succeed(VoiceOutputConfiguration, defaultVoiceOutputSettings)
      )
    )
  )
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sessions = yield* Voice
          const join = yield* sessions.start(startVoiceRequest())
          yield* capture.segment(fixture)
          yield* Deferred.await(accepted).pipe(Effect.timeout("2 seconds"))
          const first = yield* sessions.snapshot(join.sessionId, 0)
          expect(conflictCode).toBe("DeliveryConflict")
          expect(first.events.filter((event) => event.kind === "Accepted")).toHaveLength(1)
          expect(first.pending[0]?.receipt?.text).toBe("Привет")
          expect(first.pending[0]?.error).toBeNull()
          const pending = first.pending[0]
          if (pending === undefined) throw new Error("Expected finalized admission")
          expect(
            (yield* sessions.resolve({
              admissions: [
                {
                  backendIncarnationId: pending.backendIncarnationId,
                  sessionId: join.sessionId,
                  deliveryId: pending.deliveryId
                }
              ]
            })).admissions[0]?.status
          ).toBe("Accepted")
          expect(
            (yield* sessions.snapshot(join.sessionId, 0)).events.filter((event) => event.kind === "Accepted")
          ).toHaveLength(1)
        })
      ).pipe(Effect.provide(Layer.merge(voice, conversation)))
    )
  } finally {
    await database.close()
  }
})
