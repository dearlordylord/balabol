import { Effect } from "effect"
import { expect, it } from "vitest"
import { Voice, VoiceAdmissions } from "../src/voice/index.ts"
import { Conversation } from "../src/conversation/index.ts"
import { SqliteMemoryStorage } from "../src/memory/index.ts"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { replyLayer } from "./reply-fixture.ts"
import { voiceOutputLayer, withVoiceOutput } from "./voice-output-fixture.ts"
import { voiceTransportFixture } from "./voice-fixture.ts"
it("migrates real legacy speech checkpoints with empty annotations and resolves their exact durable receipt", async () => {
  const database = await temporaryDatabase()
  const association = {
    backendIncarnationId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    deliveryId: crypto.randomUUID()
  }
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          const resource = yield* SqliteMemoryStorage
          yield* conversation.send({ deliveryId: association.deliveryId, text: "Legacy speech" })
          resource.storage.database.exec(
            "CREATE TABLE voice_admissions(deliveryId TEXT PRIMARY KEY,backendIncarnationId TEXT NOT NULL,sessionId TEXT NOT NULL,payloadHash TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('Open','Sealed')))"
          )
          resource.storage.database
            .prepare("INSERT INTO voice_admissions VALUES(?,?,?,?,'Open')")
            .run(
              association.deliveryId,
              association.backendIncarnationId,
              association.sessionId,
              "35f05972c7d377370eab3cfbb454944729d91d43c679f1ee694ecdcbfc2491f4"
            )
        })
      ).pipe(Effect.provide(replyLayer(database.path, fakeAnswerLayer(0))))
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const voice = yield* Voice
          const response = yield* voice.resolve({ admissions: [association] })
          expect(response.admissions[0]?.status).toBe("Accepted")
          expect(response.admissions[0]?.receipt?.text).toBe("Legacy speech")
          expect(response.admissions[0]?.receipt?.languageSpans).toEqual([])
          expect(JSON.stringify(response)).not.toContain("Hash")
        })
      ).pipe(Effect.provide(voiceOutputLayer(database.path, voiceTransportFixture())))
    )
  } finally {
    await database.close()
  }
})
it("binds canonical annotations and returns a definite rejection only after admission is sealed", () =>
  withVoiceOutput(() =>
    Effect.gen(function* () {
      const voice = yield* Voice
      const admissions = yield* VoiceAdmissions
      const conversation = yield* Conversation
      const association = {
        backendIncarnationId: admissions.backendIncarnationId,
        sessionId: crypto.randomUUID(),
        deliveryId: crypto.randomUUID()
      }
      yield* admissions.begin({
        ...association,
        text: "Bonjour",
        languageSpans: [{ language: "FR", start: 0, end: 7 }]
      })
      yield* conversation.send({
        deliveryId: association.deliveryId,
        text: "Bonjour",
        languageSpans: [{ language: "en", start: 0, end: 7 }]
      })
      expect((yield* voice.resolve({ admissions: [association] })).admissions[0]?.status).toBe("Unknown")
      yield* admissions.seal(association)
      expect((yield* voice.resolve({ admissions: [association] })).admissions[0]?.status).toBe("NotAccepted")
      const matching = { ...association, deliveryId: crypto.randomUUID() }
      yield* admissions.begin({ ...matching, text: "Bonjour", languageSpans: [{ language: "FR", start: 0, end: 7 }] })
      yield* conversation.send({
        deliveryId: matching.deliveryId,
        text: "Bonjour",
        languageSpans: [{ language: "fr", start: 0, end: 7 }]
      })
      expect((yield* voice.resolve({ admissions: [matching] })).admissions[0]?.status).toBe("Accepted")
    })
  ))
it("rejects out-of-bounds and scalar-splitting admission annotations without creating durable evidence", () =>
  withVoiceOutput(() =>
    Effect.gen(function* () {
      const store = yield* VoiceAdmissions
      const voice = yield* Voice
      for (const spans of [[{ language: "en", start: 0, end: 20 }], [{ language: "en", start: 1, end: 7 }]]) {
        const association = {
          backendIncarnationId: store.backendIncarnationId,
          sessionId: crypto.randomUUID(),
          deliveryId: crypto.randomUUID()
        }
        expect((yield* Effect.flip(store.begin({ ...association, text: "😀wrong", languageSpans: spans }))).code).toBe(
          "InvalidInput"
        )
        expect(yield* store.find(association)).toBeNull()
        expect((yield* voice.resolve({ admissions: [association] })).admissions[0]?.status).toBe("Unknown")
        yield* store.begin({ ...association, text: "😀wrong", languageSpans: [{ language: "en", start: 0, end: 7 }] })
        expect((yield* store.find(association))?.state).toBe("Open")
      }
    })
  ))
