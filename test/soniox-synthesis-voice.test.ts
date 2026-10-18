import { Effect, Redacted } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import { sonioxSynthesisLayer } from "../src/speech-synthesis/index.ts"
import { Voice } from "../src/voice/index.ts"
import { startVoiceRequest } from "./voice-admission-fixture.ts"
import { outputInput, waitForOutput, withVoiceOutput } from "./voice-output-fixture.ts"
import { waitForReply } from "./reply-fixture.ts"
import { SonioxSynthesisSocket } from "./soniox-synthesis-fixture.ts"
const settings = { provider: "soniox" as const, apiKey: Redacted.make("fixture-only"), voice: "Adrian" }
it("delivers cloud synthesis only after publication readiness and persists completed replies", () => {
  const socket = new SonioxSynthesisSocket((stream_id) => [
    { stream_id, audio: Buffer.alloc(4800, 1).toString("base64"), audio_end: true },
    { stream_id, terminated: true }
  ])
  return withVoiceOutput(
    (transport) =>
      Effect.gen(function* () {
        const voice = yield* Voice
        const conversation = yield* Conversation
        const join = yield* voice.start(startVoiceRequest())
        yield* conversation.send(outputInput)
        const waiting = (yield* waitForOutput(voice, join.sessionId, "AwaitingReady")).output
        if (waiting?.manifest == null) throw new Error("Missing output publication")
        expect(transport.captured).toEqual([])
        yield* voice.ready(join.sessionId, {
          responseId: waiting.responseId,
          outputEpoch: waiting.outputEpoch,
          trackSid: waiting.manifest.trackSid
        })
        yield* waitForOutput(voice, join.sessionId, "Delivered")
        expect(transport.captured.reduce((frames, chunk) => frames + chunk.frames, 0)).toBeGreaterThan(0)
        expect((yield* conversation.reply(outputInput.deliveryId)).state).toBe("Completed")
        expect((yield* conversation.page({ limit: 100 })).messages).toHaveLength(2)
        expect(socket.closed).toBe(true)
        yield* voice.end(join.sessionId)
      }),
    sonioxSynthesisLayer(settings, socket.factory)
  )
})
it("preserves actionable synthesis authentication failure through Voice and durable reply delivery", () => {
  const socket = new SonioxSynthesisSocket([{ error_code: 401, error_message: "vendor-secret-must-not-appear" }])
  return withVoiceOutput(
    () =>
      Effect.gen(function* () {
        const voice = yield* Voice
        const conversation = yield* Conversation
        const join = yield* voice.start(startVoiceRequest())
        yield* conversation.send(outputInput)
        const output = (yield* waitForOutput(voice, join.sessionId, "AwaitingReady")).output
        if (output?.manifest == null) throw new Error("Missing output publication")
        yield* voice.ready(join.sessionId, {
          responseId: output.responseId,
          outputEpoch: output.outputEpoch,
          trackSid: output.manifest.trackSid
        })
        const failed = yield* waitForOutput(voice, join.sessionId, "Failed")
        expect(JSON.stringify(failed)).toContain("SONIOX_API_KEY")
        expect(JSON.stringify(failed)).not.toContain("vendor-secret-must-not-appear")
        const reply = yield* waitForReply(conversation, outputInput.deliveryId)
        expect(reply.state).toBe("Failed")
        const messages = (yield* conversation.page({ limit: 100 })).messages
        expect(JSON.stringify(messages)).toContain("SONIOX_API_KEY")
        expect(socket.closed).toBe(true)
        yield* voice.end(join.sessionId)
      }),
    sonioxSynthesisLayer(settings, socket.factory)
  )
})
