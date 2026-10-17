import { classifiedVoiceInput } from "./voice-output-fixture.ts"
import { Deferred, Effect, Layer } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { fakeRecognitionLayer } from "../src/speech-recognition/index.ts"
import { fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import {
  Voice,
  VoiceAdmissions,
  VoiceTransport,
  VoiceLanguageConfiguration,
  VoiceOutputConfiguration,
  defaultVoiceLanguageConfiguration,
  defaultVoiceOutputSettings
} from "../src/voice/index.ts"
import { replyLayer } from "./reply-fixture.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { voiceTransportFixture } from "./voice-fixture.ts"
import { startVoiceRequest } from "./voice-admission-fixture.ts"
for (const boundary of ["association", "publication"] as const) {
  it(`reserves voice intent before waiting for ${boundary} and retains it across capture close`, async () => {
    const database = await temporaryDatabase()
    const transport = voiceTransportFixture()
    const conversation = replyLayer(database.path, fakeAnswerLayer(0))
    const fixture = Layer.effect(
      Voice,
      Effect.gen(function* () {
        const input = yield* classifiedVoiceInput()
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const checkpoint = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
        const fenced = yield* Deferred.make<void>()
        const media = yield* VoiceTransport
        const durable = yield* Conversation
        const controlled = Layer.succeed(
          Conversation,
          Conversation.of({
            ...durable,
            fenceSpeech: (input) =>
              durable
                .fenceSpeech(input)
                .pipe(Effect.tap(() => (input.sequence > 1 ? Deferred.succeed(fenced, undefined) : Effect.void)))
          })
        )
        const voice = Voice.configuredLayer.pipe(
          Layer.provide(
            Layer.mergeAll(
              controlled,
              input.layer,
              Layer.succeed(VoiceLanguageConfiguration, defaultVoiceLanguageConfiguration),
              Layer.succeed(VoiceOutputConfiguration, defaultVoiceOutputSettings),
              fakeSynthesisLayer(),
              fakeRecognitionLayer({
                languages: ["ru", "fr", "en"],
                scripts: [
                  { events: [{ kind: "Final", text: "handed input", spans: [] }], delayMillis: 0, failure: null }
                ]
              }),
              Layer.succeed(VoiceAdmissions, {
                backendIncarnationId: crypto.randomUUID(),
                begin: () => (boundary === "association" ? checkpoint : Effect.void),
                seal: () => Effect.void,
                find: () => Effect.succeed(null)
              }),
              Layer.succeed(VoiceTransport, {
                open: (...args) =>
                  media
                    .open(...args)
                    .pipe(
                      Effect.map((opened) => ({
                        ...opened,
                        connection: {
                          ...opened.connection,
                          publish: (event) =>
                            event.kind === "Final" && boundary === "publication"
                              ? checkpoint
                              : opened.connection.publish(event)
                        }
                      }))
                    )
              })
            )
          )
        )
        return yield* Effect.gen(function* () {
          const sessions = yield* Voice
          const durable = yield* Conversation
          const join = yield* sessions.start(startVoiceRequest())
          yield* input.segment(transport)
          yield* Deferred.await(entered).pipe(Effect.timeout("2 seconds"))
          for (let index = 0; index < 3; index++) yield* input.send(transport, transport.audio(1200))
          yield* Deferred.await(fenced).pipe(Effect.timeout("2 seconds"))
          yield* sessions.end(join.sessionId)
          yield* Deferred.succeed(release, undefined)
          let snapshot = yield* sessions.snapshot(join.sessionId, 0)
          for (let index = 0; snapshot.pending[0]?.receipt == null && index < 100; index++) {
            yield* Effect.sleep(5)
            snapshot = yield* sessions.snapshot(join.sessionId, 0)
          }
          expect(snapshot.pending[0]?.receipt?.text).toBe("handed input")
          expect(
            (yield* durable.page({ limit: 100 })).messages.filter((row) => row.role === "user").map((row) => row.text)
          ).toEqual(["handed input"])
          const id = snapshot.pending[0]?.deliveryId
          if (id === undefined) throw new Error("Expected handed input identity")
          let reply = yield* durable.reply(id)
          for (let index = 0; reply.state === "Waiting" && index < 100; index++) {
            yield* Effect.sleep(5)
            reply = yield* durable.reply(id)
          }
          expect(reply.state).toBe("Interrupted")
          return sessions
        }).pipe(Effect.provide(Layer.merge(voice, controlled)), Effect.ensuring(Deferred.succeed(release, undefined)))
      })
    ).pipe(Layer.provide(Layer.merge(transport.layer, conversation)))
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* Voice
          }).pipe(Effect.provide(fixture))
        )
      )
    } finally {
      await database.close()
    }
  })
}
