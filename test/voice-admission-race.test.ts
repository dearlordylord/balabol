import { Effect, Layer } from "effect"
import { expect, it } from "vitest"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { Conversation } from "../src/conversation/index.ts"
import { Voice, VoiceTransport } from "../src/voice/index.ts"
import { fakeRecognitionLayer } from "../src/speech-recognition/index.ts"
import { fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import { voiceTransportFixture } from "./voice-fixture.ts"
import { voiceOutputLayer, waitForOutput, classifiedVoiceInput } from "./voice-output-fixture.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { startVoiceRequest } from "./voice-admission-fixture.ts"

it("interrupts only the old accepted reply when new speech starts during Final publication", async () => {
  const database = await temporaryDatabase()
  const fixture = voiceTransportFixture()
  const input = await Effect.runPromise(classifiedVoiceInput())
  let reached = false
  let release: () => void = () => {}
  const publication = new Promise<void>((resolve) => {
    release = resolve
  })
  const transport = Layer.effect(
    VoiceTransport,
    Effect.gen(function* () {
      const base = yield* VoiceTransport
      return VoiceTransport.of({
        open: (...args) =>
          base.open(...args).pipe(
            Effect.map((opened) => ({
              ...opened,
              connection: {
                ...opened.connection,
                publish: (event) =>
                  opened.connection.publish(event).pipe(
                    Effect.andThen(
                      event.kind === "Final"
                        ? Effect.promise(() => {
                            reached = true
                            return publication
                          })
                        : Effect.void
                    )
                  )
              }
            }))
          )
      })
    })
  ).pipe(Layer.provide(fixture.layer))
  const answer = fakeAnswerLayer(0)
  const recognition = fakeRecognitionLayer({
    languages: ["ru", "fr", "en"],
    scripts: [
      {
        events: [{ kind: "Final", text: "accepted before resumed speech", spans: [], detectedLanguage: "en" }],
        delayMillis: 0,
        failure: null
      }
    ]
  })
  const application = voiceOutputLayer(
    database.path,
    { ...fixture, layer: transport },
    fakeSynthesisLayer({ delayMillis: 0 }),
    answer,
    recognition,
    undefined,
    undefined,
    input.layer
  )
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const voice = yield* Voice
          const conversation = yield* Conversation
          const join = yield* voice.start(startVoiceRequest())
          yield* input.segment(fixture)
          for (let i = 0; !reached && i < 200; i++) yield* Effect.sleep(5)
          expect(reached).toBe(true)
          for (let i = 0; i < 10; i++) yield* input.send(fixture, fixture.audio(1200))
          release()
          let turn = yield* conversation.currentTurn()
          for (let i = 0; turn?.reply.state !== "Interrupted" && i < 200; i++) {
            yield* Effect.sleep(5)
            turn = yield* conversation.currentTurn()
          }
          expect(turn?.reply.state).toBe("Interrupted")
          expect(
            (yield* conversation.page({ limit: 100 })).messages
              .filter((message) => message.role === "user")
              .map((message) => message.text)
          ).toEqual(["accepted before resumed speech"])
          expect(fixture.captured).toEqual([])
          expect(fixture.publications).toEqual([])
          const fresh = yield* conversation.send({ deliveryId: crypto.randomUUID(), text: "new valid reply" })
          const output = (yield* waitForOutput(voice, join.sessionId, "AwaitingReady")).output
          if (output?.manifest == null) throw new Error("Missing fresh output")
          expect(output.inputDeliveryId).toBe(fresh.deliveryId)
          yield* voice.ready(join.sessionId, {
            responseId: output.responseId,
            outputEpoch: output.outputEpoch,
            trackSid: output.manifest.trackSid
          })
          expect((yield* waitForOutput(voice, join.sessionId, "Delivered")).output?.status).toBe("Delivered")
          expect(fixture.captured.length).toBeGreaterThan(0)
          yield* voice.end(join.sessionId)
        })
      ).pipe(Effect.provide(application))
    )
  } finally {
    release()
    await database.close()
  }
})
