import { Effect, Layer } from "effect"
import { expect, it } from "vitest"
import { Conversation, StorageUnavailable } from "../src/conversation/index.ts"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { fakeRecognitionLayer } from "../src/speech-recognition/index.ts"
import { fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import { Voice } from "../src/voice/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { replyLayer } from "./reply-fixture.ts"
import { startVoiceRequest, voiceAdmissionsFixture } from "./voice-admission-fixture.ts"
import { voiceTransportFixture } from "./voice-fixture.ts"
import { outputInput, waitForOutput } from "./voice-output-fixture.ts"

it("never reports delivery when completion settlement fails and delivers an explicitly supplied fresh response", async () => {
  const database = await temporaryDatabase()
  const transport = voiceTransportFixture()
  const conversation = replyLayer(database.path, fakeAnswerLayer(0))
  const completedAttempts: string[] = []
  const decorated = Layer.effect(
    Conversation,
    Effect.gen(function* () {
      const real = yield* Conversation
      return Conversation.of({
        ...real,
        settleReplyDelivery: (ticket) =>
          Effect.suspend(() => {
            if (ticket.outcome === "Completed") {
              completedAttempts.push(ticket.inputDeliveryId)
              if (completedAttempts.length === 1)
                return Effect.fail(new StorageUnavailable({ message: "Completion settlement unavailable" }))
            }
            return real.settleReplyDelivery(ticket)
          })
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
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const voice = yield* Voice
        const durable = yield* Conversation
        const join = yield* voice.start(startVoiceRequest())
        yield* durable.send(outputInput)
        const first = (yield* waitForOutput(voice, join.sessionId, "AwaitingReady")).output
        if (first?.manifest == null) throw new Error("Missing first publication")
        yield* voice.ready(join.sessionId, {
          responseId: first.responseId,
          outputEpoch: first.outputEpoch,
          trackSid: first.manifest.trackSid
        })
        const failed = yield* waitForOutput(voice, join.sessionId, "Failed")
        expect(failed.output?.status).toBe("Failed")
        expect(failed.output?.error?.code).toBe("AudioUnavailable")
        expect(failed.events.some((event) => event.kind === "Output" && event.output.status === "Delivered")).toBe(
          false
        )
        expect((yield* durable.reply(outputInput.deliveryId)).receipt).toBeNull()
        expect(completedAttempts).toEqual([outputInput.deliveryId])
        expect(transport.publications[0]?.invalidated).toBe(true)
        const fresh = yield* durable.send({ deliveryId: crypto.randomUUID(), text: "Explicit fresh input" })
        const next = (yield* waitForOutput(voice, join.sessionId, "AwaitingReady")).output
        if (next?.manifest == null) throw new Error("Missing fresh publication")
        expect(next.inputDeliveryId).toBe(fresh.deliveryId)
        expect(next.outputEpoch).not.toBe(first.outputEpoch)
        yield* voice.ready(join.sessionId, {
          responseId: next.responseId,
          outputEpoch: next.outputEpoch,
          trackSid: next.manifest.trackSid
        })
        expect((yield* waitForOutput(voice, join.sessionId, "Delivered")).output?.status).toBe("Delivered")
        expect(completedAttempts).toEqual([outputInput.deliveryId, fresh.deliveryId])
        expect((yield* durable.reply(fresh.deliveryId)).receipt?.outcome).toBe("completed")
        expect((yield* durable.reply(outputInput.deliveryId)).receipt?.outcome).toBe("interrupted")
        yield* voice.end(join.sessionId)
        expect(transport.publications.every((publication) => publication.closed)).toBe(true)
      }).pipe(Effect.scoped, Effect.provide(application))
    )
  } finally {
    await database.close()
  }
})
