import { Effect, Layer } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import { fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import { Voice, VoiceTransport, VoiceFailed } from "../src/voice/index.ts"
import { startVoiceRequest } from "./voice-admission-fixture.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { voiceTransportFixture } from "./voice-fixture.ts"
import { outputInput, voiceOutputLayer, waitForOutput } from "./voice-output-fixture.ts"
import { waitForReply } from "./reply-fixture.ts"

it("reports failed publication acquisition without leaking media and delivers a fresh input", async () => {
  const database = await temporaryDatabase()
  const transport = voiceTransportFixture()
  let attempts = 0
  const layer = Layer.effect(
    VoiceTransport,
    Effect.gen(function* () {
      const real = yield* VoiceTransport
      return VoiceTransport.of({
        open: (...args) =>
          real.open(...args).pipe(
            Effect.map((opened) => ({
              ...opened,
              connection: {
                ...opened.connection,
                openOutput: (...outputArgs) =>
                  Effect.suspend(() => {
                    attempts += 1
                    return attempts === 1
                      ? Effect.fail(
                          new VoiceFailed({ code: "AudioUnavailable", message: "Publication acquisition failed" })
                        )
                      : opened.connection.openOutput(...outputArgs)
                  })
              }
            }))
          )
      })
    })
  ).pipe(Layer.provide(transport.layer))
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const voice = yield* Voice
        const conversation = yield* Conversation
        const join = yield* voice.start(startVoiceRequest())
        yield* conversation.send(outputInput)
        const failed = (yield* waitForOutput(voice, join.sessionId, "Failed")).output
        expect(failed?.status).toBe("Failed")
        expect(failed?.error?.code).toBe("AudioUnavailable")
        expect(failed?.manifest).toBeNull()
        expect((yield* waitForReply(conversation, outputInput.deliveryId)).receipt?.outcome).toBe("interrupted")
        expect(attempts).toBe(1)
        expect(transport.publications).toEqual([])
        expect(transport.captured).toEqual([])
        const fresh = yield* conversation.send({ deliveryId: crypto.randomUUID(), text: "Healthy publication" })
        const next = (yield* waitForOutput(voice, join.sessionId, "AwaitingReady")).output
        if (next?.manifest == null) throw new Error("Missing fresh publication")
        expect(next.inputDeliveryId).toBe(fresh.deliveryId)
        yield* voice.ready(join.sessionId, {
          responseId: next.responseId,
          outputEpoch: next.outputEpoch,
          trackSid: next.manifest.trackSid
        })
        expect((yield* waitForOutput(voice, join.sessionId, "Delivered")).output?.status).toBe("Delivered")
        expect((yield* conversation.reply(fresh.deliveryId)).receipt?.outcome).toBe("completed")
        expect(attempts).toBe(2)
        expect(transport.publications).toHaveLength(1)
        expect(transport.captured.length).toBeGreaterThan(0)
        yield* voice.end(join.sessionId)
        expect(transport.publications[0]?.closed).toBe(true)
      }).pipe(
        Effect.scoped,
        Effect.provide(voiceOutputLayer(database.path, { ...transport, layer }, fakeSynthesisLayer({ delayMillis: 0 })))
      )
    )
  } finally {
    await database.close()
  }
})
