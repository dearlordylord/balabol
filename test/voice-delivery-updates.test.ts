import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import { SpeechSynthesis, fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { VoiceTransport, defaultVoiceOutputSettings } from "../src/voice/index.ts"
import { ReplyAudio } from "../src/voice/output.ts"
import { replyLayer } from "./reply-fixture.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { voiceTransportFixture } from "./voice-fixture.ts"
const identity = "11111111-1111-4111-8111-111111111111"

it("projects coalesced invalidation without starting publication when Started was never observed", async () => {
  const database = await temporaryDatabase()
  const transport = voiceTransportFixture()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          const synthesis = yield* SpeechSynthesis
          const media = yield* VoiceTransport
          const scope = yield* Effect.scope
          const opened = yield* media.open(
            { sessionId: identity, roomName: identity, participantIdentity: identity },
            () => {},
            () => {},
            () => {}
          )
          const ticket = {
            registrationId: identity,
            deliveryId: identity,
            inputDeliveryId: identity,
            responseId: identity,
            deadlineAt: 60000
          }
          const observed = Conversation.of({
            ...conversation,
            registerReplyDelivery: () =>
              Effect.succeed({
                registrationId: identity,
                snapshot: { kind: "Invalidated", registrationId: identity, sequence: 2, ticket, reason: "Interrupted" },
                updates: Stream.empty
              })
          })
          const audio = new ReplyAudio(
            identity,
            observed,
            synthesis,
            opened.connection,
            scope,
            () => Effect.void,
            defaultVoiceOutputSettings
          )
          yield* audio.attach()
          expect(audio.snapshot?.status).toBe("Interrupted")
          expect(audio.snapshot?.responseId).toBe(identity)
          expect(transport.publications).toEqual([])
          yield* audio.close()
        })
      ).pipe(
        Effect.provide(
          Layer.mergeAll(replyLayer(database.path, fakeAnswerLayer(0)), fakeSynthesisLayer(), transport.layer)
        )
      )
    )
  } finally {
    await database.close()
  }
})

it("closes publication acquired after its exact response was revoked without exposing readiness", async () => {
  const database = await temporaryDatabase()
  const transport = voiceTransportFixture()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          const synthesis = yield* SpeechSynthesis
          const media = yield* VoiceTransport
          const scope = yield* Effect.scope
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const opened = yield* media.open(
            { sessionId: identity, roomName: identity, participantIdentity: identity },
            () => {},
            () => {},
            () => {}
          )
          const observed = {
            ...opened.connection,
            openOutput: (epoch: string, authorization: Parameters<typeof opened.connection.openOutput>[1]) =>
              opened.connection.openOutput(epoch, authorization).pipe(
                Effect.tap(() => Deferred.succeed(entered, undefined)),
                Effect.tap(() => Deferred.await(release)),
                Effect.uninterruptible
              )
          }
          const audio = new ReplyAudio(
            identity,
            conversation,
            synthesis,
            observed,
            scope,
            () => Effect.void,
            defaultVoiceOutputSettings
          )
          yield* audio.attach()
          yield* conversation.send({ deliveryId: identity, text: "publication awaiting" })
          yield* Deferred.await(entered).pipe(Effect.timeout("2 seconds"))
          const output = audio.snapshot
          if (output === null) throw new Error("Missing response")
          const interrupt = yield* conversation.interruptResponse(output).pipe(Effect.forkChild)
          yield* Fiber.join(interrupt)
          yield* Deferred.succeed(release, undefined)
          yield* audio.close()
          expect(transport.publications).toHaveLength(1)
          expect(transport.publications[0]?.closed).toBe(true)
          expect(audio.snapshot?.manifest).toBeNull()
          expect(transport.captured).toEqual([])
        })
      ).pipe(
        Effect.provide(
          Layer.mergeAll(replyLayer(database.path, fakeAnswerLayer(0)), fakeSynthesisLayer(), transport.layer)
        )
      )
    )
  } finally {
    await database.close()
  }
})
