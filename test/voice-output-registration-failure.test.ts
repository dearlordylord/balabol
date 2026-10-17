import { Effect } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import { Voice } from "../src/voice/index.ts"
import { fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import { startVoiceRequest } from "./voice-admission-fixture.ts"
import { outputInput, withVoiceOutput, waitForOutput } from "./voice-output-fixture.ts"

it("cleans up a voice start rejected by busy delivery registration and delivers after the slot is released", () =>
  withVoiceOutput(
    (transport) =>
      Effect.gen(function* () {
        const voice = yield* Voice
        const conversation = yield* Conversation
        const occupied = yield* conversation.registerReplyDelivery({ completionMillis: 60000 })
        yield* Effect.gen(function* () {
          const rejected = yield* Effect.flip(voice.start(startVoiceRequest()))
          expect(rejected.code).toBe("AudioUnavailable")
          expect(transport.opens()).toBe(1)
          expect(transport.closed()).toBe(true)
          expect(transport.publications).toEqual([])
          expect(transport.captured).toEqual([])
        }).pipe(Effect.ensuring(conversation.unregisterReplyDelivery(occupied.registrationId).pipe(Effect.orDie)))
        const fresh = yield* voice.start(startVoiceRequest())
        expect(transport.opens()).toBe(2)
        yield* conversation.send(outputInput)
        const waiting = (yield* waitForOutput(voice, fresh.sessionId, "AwaitingReady")).output
        if (waiting?.manifest == null) throw new Error("Missing fresh publication")
        yield* voice.ready(fresh.sessionId, {
          responseId: waiting.responseId,
          outputEpoch: waiting.outputEpoch,
          trackSid: waiting.manifest.trackSid
        })
        expect((yield* waitForOutput(voice, fresh.sessionId, "Delivered")).output?.status).toBe("Delivered")
        expect((yield* conversation.reply(outputInput.deliveryId)).receipt?.outcome).toBe("completed")
        expect(transport.publications).toHaveLength(1)
        expect(transport.captured.length).toBeGreaterThan(0)
      }),
    fakeSynthesisLayer({ delayMillis: 0 })
  ))
