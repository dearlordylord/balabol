import { Effect, Layer } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import { fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import { Voice, VoiceTransport } from "../src/voice/index.ts"
import { startVoiceRequest } from "./voice-admission-fixture.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { voiceTransportFixture } from "./voice-fixture.ts"
import { outputInput, voiceOutputLayer, waitForOutput } from "./voice-output-fixture.ts"
import { waitForReply } from "./reply-fixture.ts"

it("reports a spontaneous drain interruption and delivers a fresh response", async () => {
  const database = await temporaryDatabase()
  const transport = voiceTransportFixture()
  let publications = 0
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
                  opened.connection.openOutput(...outputArgs).pipe(
                    Effect.map((publication) => {
                      publications += 1
                      return publications === 1 ? { ...publication, drain: () => Effect.interrupt } : publication
                    })
                  )
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
        const first = (yield* waitForOutput(voice, join.sessionId, "AwaitingReady")).output
        if (first?.manifest == null) throw new Error("Missing first publication")
        yield* voice.ready(join.sessionId, {
          responseId: first.responseId,
          outputEpoch: first.outputEpoch,
          trackSid: first.manifest.trackSid
        })
        const failed = (yield* waitForOutput(voice, join.sessionId, "Failed")).output
        expect(failed?.status).toBe("Failed")
        expect(failed?.error?.code).toBe("AudioUnavailable")
        expect((yield* waitForReply(conversation, outputInput.deliveryId)).receipt?.outcome).toBe("interrupted")
        expect(transport.publications[0]?.invalidated).toBe(true)
        expect(transport.publications[0]?.closed).toBe(true)
        const oldFrames = transport.captured.filter((audio) => audio.outputEpoch === first.outputEpoch)
        expect(oldFrames.length).toBeGreaterThan(0)
        const fresh = yield* conversation.send({ deliveryId: crypto.randomUUID(), text: "Healthy fresh response" })
        const next = (yield* waitForOutput(voice, join.sessionId, "AwaitingReady")).output
        if (next?.manifest == null) throw new Error("Missing fresh publication")
        expect(next.outputEpoch).not.toBe(first.outputEpoch)
        yield* voice.ready(join.sessionId, {
          responseId: next.responseId,
          outputEpoch: next.outputEpoch,
          trackSid: next.manifest.trackSid
        })
        expect((yield* waitForOutput(voice, join.sessionId, "Delivered")).output?.status).toBe("Delivered")
        expect((yield* conversation.reply(fresh.deliveryId)).receipt?.outcome).toBe("completed")
        expect(transport.captured.filter((audio) => audio.outputEpoch === first.outputEpoch)).toEqual(oldFrames)
        expect(transport.captured.some((audio) => audio.outputEpoch === next.outputEpoch)).toBe(true)
      }).pipe(
        Effect.scoped,
        Effect.provide(voiceOutputLayer(database.path, { ...transport, layer }, fakeSynthesisLayer({ delayMillis: 0 })))
      )
    )
  } finally {
    await database.close()
  }
})
