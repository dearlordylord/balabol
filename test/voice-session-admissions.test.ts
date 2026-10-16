import { classifiedVoiceInput } from "./voice-output-fixture.ts"
import { Deferred, Effect, Layer, Queue, Stream } from "effect"
import { expect, it } from "vitest"
import { Conversation, StorageUnavailable } from "../src/conversation/index.ts"
import { AnswerGeneration } from "../src/answer-generation/index.ts"
import { fakeRecognitionLayer } from "../src/speech-recognition/index.ts"
import { fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import {
  Voice,
  VoiceAdmissions,
  VoiceLanguageConfiguration,
  VoiceOutputConfiguration,
  defaultVoiceLanguageConfiguration,
  defaultVoiceOutputSettings
} from "../src/voice/index.ts"
import { replyLayer } from "./reply-fixture.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { voiceTransportFixture } from "./voice-fixture.ts"
import { startVoiceRequest, voiceAdmissionsFixture } from "./voice-admission-fixture.ts"
it("bounds the union of failed unresolved admissions and reservations before their checkpoints begin", async () => {
  const database = await temporaryDatabase()
  const transport = voiceTransportFixture()
  const input = await Effect.runPromise(classifiedVoiceInput())
  const answer = Layer.succeed(AnswerGeneration, {
    capabilities: { languages: ["ru", "fr", "en"], output: "text-deltas" },
    generate: () => Stream.never
  })
  const conversation = replyLayer(database.path, answer)
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const durable = yield* Conversation
          const stalled = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          let failedId = ""
          let stalledId = ""
          const decorated = Layer.succeed(
            Conversation,
            Conversation.of({
              ...durable,
              submitInput: (input) =>
                input.deliveryId === failedId
                  ? Effect.fail(new StorageUnavailable({ message: "controlled storage failure" }))
                  : durable.submitInput(input)
            })
          )
          const voice = Voice.configuredLayer.pipe(
            Layer.provide(
              Layer.mergeAll(
                input.layer,
                Layer.succeed(VoiceLanguageConfiguration, defaultVoiceLanguageConfiguration),
                Layer.succeed(VoiceOutputConfiguration, defaultVoiceOutputSettings),
                decorated,
                transport.layer,
                fakeSynthesisLayer(),
                fakeRecognitionLayer({
                  languages: ["ru", "fr", "en"],
                  scripts: ["failed", "stalled", "refused"].map((text) => ({
                    events: [{ kind: "Final", text, spans: [] }],
                    delayMillis: 0,
                    failure: null
                  }))
                }),
                Layer.succeed(VoiceAdmissions, {
                  backendIncarnationId: crypto.randomUUID(),
                  begin: (input) =>
                    Effect.suspend(() => {
                      if (input.text === "failed") failedId = input.deliveryId
                      if (input.text !== "stalled") return Effect.void
                      stalledId = input.deliveryId
                      return Deferred.succeed(stalled, undefined).pipe(Effect.andThen(Deferred.await(release)))
                    }),
                  seal: () => Effect.void,
                  find: () => Effect.succeed(null)
                })
              )
            )
          )
          yield* Effect.gen(function* () {
            const sessions = yield* Voice
            const join = yield* sessions.start(startVoiceRequest())
            yield* input.segment(transport)
            let snapshot = yield* sessions.snapshot(join.sessionId, 0)
            for (let index = 0; snapshot.pending[0]?.error == null && index < 100; index++) {
              yield* Effect.sleep(5)
              snapshot = yield* sessions.snapshot(join.sessionId, 0)
            }
            expect(snapshot.pending[0]?.error?.code).toBe("StorageUnavailable")
            yield* input.segment(transport)
            yield* Deferred.await(stalled).pipe(Effect.timeout("2 seconds"))
            yield* input.segment(transport)
            for (
              let index = 0;
              !transport.published.some((event) => event.kind === "Error" && event.code === "RecognitionFailed") &&
              index < 100;
              index++
            )
              yield* Effect.sleep(5)
            expect(
              transport.published.some((event) => event.kind === "Error" && event.code === "RecognitionFailed")
            ).toBe(true)
            yield* Deferred.succeed(release, undefined)
            snapshot = yield* sessions.snapshot(join.sessionId, 0)
            for (
              let index = 0;
              !snapshot.pending.some((input) => input.deliveryId === stalledId && input.receipt !== null) &&
              index < 100;
              index++
            ) {
              yield* Effect.sleep(5)
              snapshot = yield* sessions.snapshot(join.sessionId, 0)
            }
            expect(snapshot.pending.map((input) => input.utteranceId).sort()).toEqual([failedId, stalledId].sort())
            expect(snapshot.pending).toHaveLength(2)
            yield* sessions.end(join.sessionId)
          }).pipe(Effect.provide(voice), Effect.ensuring(Deferred.succeed(release, undefined)))
        }).pipe(Effect.provide(conversation))
      )
    )
  } finally {
    await database.close()
  }
})

it("retains both ended sessions with unresolved handed input until matching recovery frees a slot", async () => {
  const database = await temporaryDatabase()
  const transport = voiceTransportFixture()
  const input = await Effect.runPromise(classifiedVoiceInput())
  const conversation = replyLayer(
    database.path,
    Layer.succeed(AnswerGeneration, {
      capabilities: { languages: ["ru", "fr", "en"], output: "text-deltas" },
      generate: () => Stream.never
    })
  )
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const durable = yield* Conversation
          const handed = yield* Queue.unbounded<Parameters<Conversation["Service"]["submitInput"]>[0]>()
          const decorated = Layer.succeed(
            Conversation,
            Conversation.of({
              ...durable,
              submitInput: (reservation) =>
                Queue.offer(handed, reservation).pipe(
                  Effect.andThen(Effect.fail(new StorageUnavailable({ message: "Controlled unresolved handoff" })))
                )
            })
          )
          const application = Voice.configuredLayer.pipe(
            Layer.provide(
              Layer.mergeAll(
                input.layer,
                Layer.succeed(VoiceLanguageConfiguration, defaultVoiceLanguageConfiguration),
                Layer.succeed(VoiceOutputConfiguration, defaultVoiceOutputSettings),
                decorated,
                transport.layer,
                fakeSynthesisLayer(),
                fakeRecognitionLayer({
                  languages: ["ru", "fr", "en"],
                  scripts: ["first retained input", "second retained input"].map((text) => ({
                    events: [{ kind: "Final", text, spans: [] }],
                    delayMillis: 0,
                    failure: null
                  }))
                }),
                voiceAdmissionsFixture().pipe(Layer.provide(conversation))
              )
            )
          )
          yield* Effect.gen(function* () {
            const voice = yield* Voice
            const first = yield* voice.start(startVoiceRequest())
            yield* input.segment(transport)
            const firstInput = yield* Queue.take(handed).pipe(Effect.timeout("2 seconds"))
            yield* voice.end(first.sessionId)
            const second = yield* voice.start(startVoiceRequest())
            yield* input.segment(transport)
            const secondInput = yield* Queue.take(handed).pipe(Effect.timeout("2 seconds"))
            yield* voice.end(second.sessionId)
            const thirdRequest = startVoiceRequest()
            expect((yield* Effect.flip(voice.start(thirdRequest))).code).toBe("VoiceBusy")
            expect(transport.opens()).toBe(2)
            for (const session of [first, second]) {
              const snapshot = yield* voice.snapshot(session.sessionId, 0)
              expect(snapshot.status).toBe("ended")
              expect(snapshot.pending).toHaveLength(1)
              expect(snapshot.pending[0]?.receipt).toBeNull()
            }
            expect((yield* durable.page({ limit: 100 })).messages).toEqual([])
            const firstReceipt = yield* durable.submitInput(firstInput)
            const recovered = yield* voice.snapshot(first.sessionId, 0)
            expect(recovered.pending[0]?.receipt).toEqual(firstReceipt)
            expect(recovered.events.filter((event) => event.kind === "Accepted")).toHaveLength(1)
            const third = yield* voice.start(thirdRequest)
            expect(transport.opens()).toBe(3)
            expect((yield* Effect.flip(voice.snapshot(first.sessionId, 0))).code).toBe("SessionNotFound")
            const secondReceipt = yield* durable.submitInput(secondInput)
            expect((yield* voice.snapshot(second.sessionId, 0)).pending[0]?.receipt).toEqual(secondReceipt)
            expect(
              (yield* durable.page({ limit: 100 })).messages
                .filter((message) => message.role === "user")
                .map((message) => message.text)
            ).toEqual(["first retained input", "second retained input"])
            yield* voice.end(third.sessionId)
          }).pipe(Effect.provide(application))
        }).pipe(Effect.provide(conversation))
      )
    )
  } finally {
    await database.close()
  }
})
