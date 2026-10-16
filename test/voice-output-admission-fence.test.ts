import { Effect, Layer } from "effect"
import { expect, it } from "vitest"
import { ReplyAudio } from "../src/voice/output.ts"
import { Conversation } from "../src/conversation/index.ts"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { SpeechSynthesis, fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import { VoiceTransport, defaultVoiceOutputSettings } from "../src/voice/index.ts"
import { voiceTransportFixture } from "./voice-fixture.ts"
import { replyLayer } from "./reply-fixture.ts"
import { temporaryDatabase } from "./memory-fixture.ts"

it("retains the stalled live admission fence when a newer admission retires and another is added", async () => {
  const database = await temporaryDatabase()
  const transport = voiceTransportFixture()
  const application = Layer.mergeAll(
    replyLayer(database.path, fakeAnswerLayer(0)),
    fakeSynthesisLayer({ delayMillis: 0 }),
    transport.layer
  )
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          const synthesis = yield* SpeechSynthesis
          const scope = yield* Effect.scope
          const sessionId = crypto.randomUUID()
          const opened = yield* (yield* VoiceTransport).open(
            { sessionId, roomName: crypto.randomUUID(), participantIdentity: crypto.randomUUID() },
            () => {},
            () => {},
            () => {}
          )
          const output = new ReplyAudio(
            sessionId,
            conversation,
            synthesis,
            opened.connection,
            scope,
            () => Effect.void,
            defaultVoiceOutputSettings
          )
          yield* output.attach()
          const stalled = crypto.randomUUID()
          const retired = crypto.randomUUID()
          const newer = crypto.randomUUID()
          output.suppressDelivery(stalled)
          output.suppressDelivery(retired)
          output.releaseAdmission(retired)
          output.suppressDelivery(stalled)
          output.suppressDelivery(newer)
          yield* conversation.send({ deliveryId: stalled, text: "late admission" })
          yield* Effect.sleep(30)
          expect(output.snapshot?.status).toBe("Interrupted")
          expect(transport.publications).toEqual([])
          expect(transport.captured).toEqual([])
          const reply = yield* conversation.reply(stalled)
          yield* conversation.interruptResponse({ inputDeliveryId: stalled, responseId: reply.responseId })
          output.releaseAdmission(stalled)
          const input = yield* conversation.send({ deliveryId: crypto.randomUUID(), text: "fresh reply" })
          for (let i = 0; output.snapshot?.status !== "AwaitingReady" && i < 200; i++) yield* Effect.sleep(5)
          const ready = output.snapshot
          if (ready?.manifest == null) throw new Error("Missing fresh publication")
          expect(ready.inputDeliveryId).toBe(input.deliveryId)
          yield* output.ready({
            responseId: ready.responseId,
            outputEpoch: ready.outputEpoch,
            trackSid: ready.manifest.trackSid
          })
          for (let i = 0; output.snapshot?.status !== "Delivered" && i < 200; i++) yield* Effect.sleep(5)
          expect(output.snapshot?.status).toBe("Delivered")
          expect(transport.captured.length).toBeGreaterThan(0)
          yield* output.close()
        })
      ).pipe(Effect.provide(application))
    )
  } finally {
    await database.close()
  }
})
