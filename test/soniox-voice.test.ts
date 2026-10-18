import { Effect, Redacted } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import { sonioxRecognitionLayer } from "../src/speech-recognition/index.ts"
import { Voice } from "../src/voice/index.ts"
import { startVoiceRequest } from "./voice-admission-fixture.ts"
import { classifiedVoiceInput, waitForOutput, withVoiceOutput } from "./voice-output-fixture.ts"
import { SonioxSocket } from "./soniox-fixture.ts"
it("accepts multilingual Soniox results through Voice and durable Conversation before delivering reply audio", async () => {
  const input = await Effect.runPromise(classifiedVoiceInput())
  const socket = new SonioxSocket([
    { tokens: [] },
    {
      tokens: [
        { text: "Bonjour ", language: "fr", is_final: true },
        { text: "привет", language: "ru", is_final: true }
      ]
    }
  ])
  await withVoiceOutput(
    (transport) =>
      Effect.gen(function* () {
        const voice = yield* Voice
        const conversation = yield* Conversation
        const join = yield* voice.start(startVoiceRequest())
        yield* input.segment(transport)
        const output = (yield* waitForOutput(voice, join.sessionId, "AwaitingReady")).output
        if (output?.manifest == null) throw new Error("Missing reply publication")
        const snapshot = yield* voice.snapshot(join.sessionId, 0)
        expect(
          snapshot.events.filter((event) => event.kind === "Interim").every((event) => event.text.length > 0)
        ).toBe(true)
        const messages = (yield* conversation.page({ limit: 100 })).messages
        expect(messages[0]).toMatchObject({
          text: "Bonjour привет",
          detectedLanguage: null,
          languageSpans: [
            { start: 0, end: 8, language: "fr" },
            { start: 8, end: 14, language: "ru" }
          ]
        })
        yield* voice.ready(join.sessionId, {
          responseId: output.responseId,
          outputEpoch: output.outputEpoch,
          trackSid: output.manifest.trackSid
        })
        yield* waitForOutput(voice, join.sessionId, "Delivered")
        expect(transport.captured.length).toBeGreaterThan(0)
        expect(socket.closed).toBe(true)
        yield* voice.end(join.sessionId)
      }),
    undefined,
    undefined,
    sonioxRecognitionLayer({ provider: "soniox", apiKey: Redacted.make("fixture-only") }, socket.factory),
    undefined,
    undefined,
    input.layer
  )
})
