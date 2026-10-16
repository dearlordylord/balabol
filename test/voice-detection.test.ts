import { Effect } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { fakeRecognitionLayer } from "../src/speech-recognition/index.ts"
import { fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import { Voice, VoiceAdmissions } from "../src/voice/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { voiceTransportFixture } from "./voice-fixture.ts"
import { withVoiceOutput, voiceOutputLayer, classifiedVoiceInput } from "./voice-output-fixture.ts"
import { startVoiceRequest } from "./voice-admission-fixture.ts"

it("admits Russian, French and English detector labels without fabricating spans", async () => {
  const input = await Effect.runPromise(classifiedVoiceInput())
  return withVoiceOutput(
    (transport) =>
      Effect.gen(function* () {
        const voice = yield* Voice
        const conversation = yield* Conversation
        const join = yield* voice.start(startVoiceRequest())
        for (const language of ["ru", "fr", "en"]) {
          yield* input.segment(transport)
          let snapshot = yield* voice.snapshot(join.sessionId, 0)
          for (
            let attempt = 0;
            !snapshot.pending.some((input) => input.detectedLanguage === language && input.receipt !== null) &&
            attempt < 200;
            attempt++
          ) {
            yield* Effect.sleep(5)
            snapshot = yield* voice.snapshot(join.sessionId, 0)
          }
          const accepted = snapshot.pending.find((input) => input.detectedLanguage === language)?.receipt
          expect(accepted?.detectedLanguage).toBe(language)
          expect(accepted?.languageSpans).toEqual([])
          expect(accepted?.responseLanguage).toBe(language)
          const final = snapshot.events.find((event) => event.kind === "Final" && event.detectedLanguage === language)
          expect(final?.kind).toBe("Final")
          if (accepted !== undefined && accepted !== null) {
            const duplicate = yield* conversation.send({
              deliveryId: accepted.deliveryId,
              text: accepted.text,
              languageSpans: [],
              detectedLanguage: language
            })
            expect(duplicate).toEqual(accepted)
            expect(
              (yield* Effect.flip(
                conversation.send({ deliveryId: accepted.deliveryId, text: accepted.text, detectedLanguage: "ja" })
              ))._tag
            ).toBe("DeliveryConflict")
          }
        }
        yield* voice.end(join.sessionId)
        expect(
          (yield* conversation.page({ limit: 100 })).messages.filter((message) => message.role === "user")
        ).toHaveLength(3)
      }),
    fakeSynthesisLayer(),
    fakeAnswerLayer(0),
    fakeRecognitionLayer({
      languages: ["ru", "fr", "en"],
      scripts: ["ru", "fr", "en"].map((detectedLanguage) => ({
        events: [{ kind: "Final", text: "fixture words", spans: [], detectedLanguage }],
        delayMillis: 0,
        failure: null
      }))
    }),
    undefined,
    undefined,
    input.layer
  )
})

it("binds detector metadata into durable admission evidence with absent-null compatibility", () =>
  withVoiceOutput(() =>
    Effect.gen(function* () {
      const store = yield* VoiceAdmissions
      const voice = yield* Voice
      const conversation = yield* Conversation
      for (const detectedLanguage of ["ru", null]) {
        const association = {
          backendIncarnationId: store.backendIncarnationId,
          sessionId: crypto.randomUUID(),
          deliveryId: crypto.randomUUID()
        }
        yield* store.begin({ ...association, text: "same words", detectedLanguage })
        yield* conversation.send({
          deliveryId: association.deliveryId,
          text: "same words",
          ...(detectedLanguage === null ? {} : { detectedLanguage: "fr" })
        })
        yield* store.seal(association)
        expect((yield* voice.resolve({ admissions: [association] })).admissions[0]?.status).toBe(
          detectedLanguage === null ? "Accepted" : "NotAccepted"
        )
      }
    })
  ))

it("recovers detector-bound acceptance after backend restart without replaying input", async () => {
  const database = await temporaryDatabase()
  let association: { backendIncarnationId: string; sessionId: string; deliveryId: string } | undefined
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const admissions = yield* VoiceAdmissions
          const conversation = yield* Conversation
          association = {
            backendIncarnationId: admissions.backendIncarnationId,
            sessionId: crypto.randomUUID(),
            deliveryId: crypto.randomUUID()
          }
          yield* admissions.begin({ ...association, text: "Привет", languageSpans: [], detectedLanguage: "RU" })
          yield* conversation.send({
            deliveryId: association.deliveryId,
            text: "Привет",
            languageSpans: [],
            detectedLanguage: "ru"
          })
        })
      ).pipe(Effect.provide(voiceOutputLayer(database.path, voiceTransportFixture())))
    )
    const previous = association
    if (previous === undefined) throw new Error("Missing admission fixture")
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const voice = yield* Voice
          const conversation = yield* Conversation
          const result = yield* voice.resolve({ admissions: [previous] })
          expect(result.admissions[0]?.status).toBe("Accepted")
          expect(result.admissions[0]?.receipt?.detectedLanguage).toBe("ru")
          expect(result.admissions[0]?.receipt?.responseLanguage).toBe("ru")
          expect(result.admissions[0]?.receipt?.languageSpans).toEqual([])
          expect(
            (yield* conversation.page({ limit: 100 })).messages.filter((message) => message.role === "user")
          ).toHaveLength(1)
        })
      ).pipe(Effect.provide(voiceOutputLayer(database.path, voiceTransportFixture())))
    )
  } finally {
    await database.close()
  }
})
