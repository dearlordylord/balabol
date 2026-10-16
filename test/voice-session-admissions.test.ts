import { Effect, Fiber, Layer, Stream } from "effect"
import { expect, it } from "vitest"
import { Session } from "../src/voice/session.ts"
import { Conversation, StorageUnavailable } from "../src/conversation/index.ts"
import { AnswerGeneration } from "../src/answer-generation/index.ts"
import { SpeechRecognition, fakeRecognitionLayer } from "../src/speech-recognition/index.ts"
import { SpeechActivity, fakeSpeechActivityLayer } from "../src/voice/index.ts"
import { replyLayer } from "./reply-fixture.ts"
import { temporaryDatabase } from "./memory-fixture.ts"

it("bounds the union of failed unresolved admissions and reservations before their checkpoints begin", async () => {
  const database = await temporaryDatabase()
  const answer = Layer.succeed(AnswerGeneration, {
    capabilities: { languages: ["ru", "fr", "en"], output: "text-deltas" },
    generate: () => Stream.never
  })
  const application = Layer.mergeAll(replyLayer(database.path, answer), fakeRecognitionLayer(), fakeSpeechActivityLayer)
  let release: () => void = () => {}
  const checkpoint = new Promise<void>((resolve) => {
    release = resolve
  })
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          const scope = yield* Effect.scope
          const provider = yield* SpeechRecognition
          const activity = yield* (yield* SpeechActivity).open()
          const failedId = crypto.randomUUID()
          const stalledId = crypto.randomUUID()
          const refusedId = crypto.randomUUID()
          let stalled = false
          const session = new Session(
            Conversation.of({
              ...conversation,
              send: (input) =>
                input.deliveryId === failedId
                  ? Effect.fail(new StorageUnavailable({ message: "controlled storage failure" }))
                  : conversation.send(input)
            }),
            provider,
            scope,
            {
              backendIncarnationId: crypto.randomUUID(),
              begin: (input) =>
                input.deliveryId === stalledId
                  ? Effect.promise(() => {
                      stalled = true
                      return checkpoint
                    })
                  : Effect.void,
              seal: () => Effect.void,
              find: () => Effect.succeed(null)
            },
            crypto.randomUUID(),
            false,
            ["en"],
            activity
          )
          yield* session.admit(failedId, "failed", [], "en")
          for (let i = 0; session.finals.get(failedId)?.error == null && i < 100; i++) yield* Effect.sleep(5)
          expect(session.finals.get(failedId)?.error).not.toBeNull()
          const pending = yield* session.admit(stalledId, "stalled", [], "en").pipe(Effect.forkIn(scope))
          for (let i = 0; !stalled && i < 100; i++) yield* Effect.sleep(5)
          expect(stalled).toBe(true)
          const refused = yield* Effect.flip(session.admit(refusedId, "refused", [], "en"))
          expect(refused.code).toBe("RecognitionFailed")
          release()
          yield* Fiber.join(pending)
          for (let i = 0; session.finals.get(stalledId)?.receipt == null && i < 100; i++) yield* Effect.sleep(5)
          expect(
            session
              .snapshot(0)
              .pending.map((input) => input.utteranceId)
              .sort()
          ).toEqual([failedId, stalledId].sort())
          expect(session.snapshot(0).pending).toHaveLength(2)
          yield* session.stop()
        })
      ).pipe(Effect.provide(application))
    )
  } finally {
    release()
    await database.close()
  }
})
