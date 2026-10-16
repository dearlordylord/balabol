import { Deferred, Effect, Fiber, Layer } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { SpeechRecognition, fakeRecognitionLayer } from "../src/speech-recognition/index.ts"
import { SpeechActivity, fakeSpeechActivityLayer } from "../src/voice/index.ts"
import { Session } from "../src/voice/session.ts"
import { replyLayer } from "./reply-fixture.ts"
import { temporaryDatabase } from "./memory-fixture.ts"

for (const boundary of ["association", "publication"] as const) {
  it(`reserves voice intent before waiting for ${boundary} and retains it across capture close`, async () => {
    const database = await temporaryDatabase()
    const application = Layer.mergeAll(
      replyLayer(database.path, fakeAnswerLayer(0)),
      fakeRecognitionLayer(),
      fakeSpeechActivityLayer
    )
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const conversation = yield* Conversation
            const scope = yield* Effect.scope
            const provider = yield* SpeechRecognition
            const activity = yield* (yield* SpeechActivity).open()
            const entered = yield* Deferred.make<void>()
            const release = yield* Deferred.make<void>()
            const checkpoint = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
            const source = yield* conversation.openInputSource()
            const session = new Session(
              conversation,
              provider,
              scope,
              {
                backendIncarnationId: crypto.randomUUID(),
                begin: () => (boundary === "association" ? checkpoint : Effect.void),
                seal: () => Effect.void,
                find: () => Effect.succeed(null)
              },
              crypto.randomUUID(),
              false,
              ["en"],
              activity,
              undefined,
              source
            )
            session.connection = {
              openOutput: () => Effect.die("No output is permitted for superseded input"),
              close: () => Effect.void,
              publish: (event) => (event.kind === "Final" && boundary === "publication" ? checkpoint : Effect.void)
            }
            const deliveryId = crypto.randomUUID()
            const admitting = yield* session.admit(deliveryId, "handed input", [], "en").pipe(Effect.forkIn(scope))
            yield* Deferred.await(entered).pipe(Effect.timeout("2 seconds"))
            yield* session.startUtterance()
            yield* session.stop()
            yield* Deferred.succeed(release, undefined)
            yield* Fiber.join(admitting)
            for (let i = 0; session.finals.get(deliveryId)?.receipt == null && i < 100; i++) yield* Effect.sleep(5)
            expect(session.finals.get(deliveryId)?.receipt?.text).toBe("handed input")
            expect(
              (yield* conversation.page({ limit: 100 })).messages
                .filter((row) => row.role === "user")
                .map((row) => row.text)
            ).toEqual(["handed input"])
            expect((yield* conversation.reply(deliveryId)).state).toBe("Interrupted")
          })
        ).pipe(Effect.provide(application))
      )
    } finally {
      await database.close()
    }
  })
}
