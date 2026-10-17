import { Deferred, Effect, Layer, Queue, Stream } from "effect"
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

it("ignores a higher-sequence wrong-response ticket sharing the current delivery id and delivers the current reply", async () => {
  const database = await temporaryDatabase()
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const transport = voiceTransportFixture()
        const injected = yield* Queue.unbounded<ReplyDeliveryUpdate>()
        const consumed = yield* Deferred.make<void>()
        let started: ReplyDeliveryUpdate | undefined
        const conversation = replyLayer(database.path, fakeAnswerLayer(0))
        const decorated = Layer.effect(
          Conversation,
          Effect.gen(function* () {
            const real = yield* Conversation
            return Conversation.of({
              ...real,
              registerReplyDelivery: (input) =>
                real.registerReplyDelivery(input).pipe(
                  Effect.map((registration) => ({
                    ...registration,
                    updates: Stream.merge(
                      registration.updates.pipe(
                        Stream.tap((update) =>
                          Effect.sync(() => {
                            if (update.kind === "Started") started = update
                          })
                        )
                      ),
                      Stream.fromQueue(injected).pipe(
                        Stream.flatMap((update) =>
                          Stream.make(update).pipe(
                            Stream.concat(Stream.fromEffect(Deferred.succeed(consumed, undefined)).pipe(Stream.drain))
                          )
                        )
                      )
                    )
                  }))
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
              fakeSynthesisLayer({ delayMillis: 0 }),
              voiceAdmissionsFixture().pipe(Layer.provide(conversation))
            )
          ),
          Layer.provideMerge(conversation)
        )
        yield* Effect.gen(function* () {
          const voice = yield* Voice
          const durable = yield* Conversation
          const join = yield* voice.start(startVoiceRequest())
          const input = yield* durable.send({ deliveryId: crypto.randomUUID(), text: "The exact current response" })
          const waiting = (yield* waitForOutput(voice, join.sessionId, "AwaitingReady")).output
          if (waiting?.manifest == null || started?.kind !== "Started") throw new Error("Missing current publication")
          yield* Queue.offer(injected, {
            kind: "Invalidated",
            registrationId: started.registrationId,
            sequence: started.sequence + 1000000,
            ticket: { ...started.ticket, responseId: crypto.randomUUID() },
            reason: "Interrupted"
          })
          yield* Deferred.await(consumed).pipe(Effect.timeout("2 seconds"))
          expect((yield* voice.snapshot(join.sessionId, 0)).output).toEqual(waiting)
          expect(transport.publications[0]?.invalidated).toBe(false)
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
        }).pipe(Effect.scoped, Effect.provide(application))
      })
    )
  } finally {
    await database.close()
  }
})
