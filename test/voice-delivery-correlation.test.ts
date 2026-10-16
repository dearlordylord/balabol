import { Deferred, Effect, Layer, Stream } from "effect"
import { expect, it } from "vitest"
import { Conversation, type ReplyDeliveryUpdate } from "../src/conversation/index.ts"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { fakeRecognitionLayer } from "../src/speech-recognition/index.ts"
import { fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import { Voice } from "../src/voice/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { replyLayer, waitForReply } from "./reply-fixture.ts"
import { startVoiceRequest, voiceAdmissionsFixture } from "./voice-admission-fixture.ts"
import { voiceTransportFixture } from "./voice-fixture.ts"
import { waitForOutput } from "./voice-output-fixture.ts"

it("ignores replayed and foreign delivery projections before delivering a real reply", async () => {
  const database = await temporaryDatabase()
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const replayed = yield* Deferred.make<void>()
        const transport = voiceTransportFixture()
        const conversation = replyLayer(database.path, fakeAnswerLayer(0))
        const decorated = Layer.effect(
          Conversation,
          Effect.gen(function* () {
            const real = yield* Conversation
            return Conversation.of({
              ...real,
              registerReplyDelivery: (input) =>
                real.registerReplyDelivery(input).pipe(
                  Effect.map((registration) => {
                    const foreign: ReplyDeliveryUpdate = {
                      kind: "Idle",
                      registrationId: crypto.randomUUID(),
                      sequence: registration.snapshot.sequence + 1000000
                    }
                    return {
                      ...registration,
                      updates: Stream.make(registration.snapshot, foreign).pipe(
                        Stream.concat(Stream.fromEffect(Deferred.succeed(replayed, undefined)).pipe(Stream.drain)),
                        Stream.concat(registration.updates)
                      )
                    }
                  })
                )
            })
          })
        ).pipe(Layer.provide(conversation))
        const application = Voice.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              decorated,
              transport.layer,
              fakeRecognitionLayer(),
              fakeSynthesisLayer(),
              voiceAdmissionsFixture().pipe(Layer.provide(conversation))
            )
          ),
          Layer.provideMerge(conversation)
        )
        yield* Effect.gen(function* () {
          const voice = yield* Voice
          const durable = yield* Conversation
          const join = yield* voice.start(startVoiceRequest())
          // The following stream is pulled only after the replayed prefix is consumed.
          yield* Deferred.await(replayed).pipe(Effect.timeout("2 seconds"))
          expect((yield* voice.snapshot(join.sessionId, 0)).output).toBeNull()
          expect(transport.publications).toEqual([])
          const input = yield* durable.send({ deliveryId: crypto.randomUUID(), text: "Deliver the current reply" })
          const waiting = (yield* waitForOutput(voice, join.sessionId, "AwaitingReady")).output
          expect(waiting?.status).toBe("AwaitingReady")
          expect(waiting?.inputDeliveryId).toBe(input.deliveryId)
          if (waiting?.manifest == null) throw new Error("Missing current reply publication")
          expect(transport.publications).toHaveLength(1)
          expect(transport.captured).toEqual([])
          yield* voice.ready(join.sessionId, {
            responseId: waiting.responseId,
            outputEpoch: waiting.outputEpoch,
            trackSid: waiting.manifest.trackSid
          })
          const delivered = (yield* waitForOutput(voice, join.sessionId, "Delivered")).output
          expect(delivered?.status).toBe("Delivered")
          expect(delivered?.outputEpoch).toBe(waiting.outputEpoch)
          expect((yield* waitForReply(durable, input.deliveryId)).receipt?.outcome).toBe("completed")
          expect(transport.publications).toHaveLength(1)
          expect(transport.captured.length).toBeGreaterThan(0)
          yield* voice.end(join.sessionId)
        }).pipe(Effect.scoped, Effect.provide(application))
      })
    )
  } finally {
    await database.close()
  }
})
