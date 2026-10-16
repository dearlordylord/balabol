import { Effect, Layer, Stream } from "effect"
import { expect, it } from "vitest"
import { AnswerGeneration } from "../src/answer-generation/index.ts"
import { Conversation } from "../src/conversation/index.ts"
import { whisperRecognitionLayer } from "../src/speech-recognition/index.ts"
import { fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import { Voice } from "../src/voice/index.ts"
import { startVoiceRequest } from "./voice-admission-fixture.ts"
import { withVoiceOutput, classifiedVoiceInput } from "./voice-output-fixture.ts"

it("discards non-speech caption finals without memory or answers while preserving separately segmented speech", async () => {
  const input = await Effect.runPromise(classifiedVoiceInput())
  let transcriptions = 0
  let answerCalls = 0
  const results = [["[BLANK AUDIO]"], ["(keyboard tapping)"], ["Bonjour ", "(keyboard tapping)", "Hello"]]
  const recognition = whisperRecognitionLayer(
    { provider: "whisper", executable: "fixture", modelPath: "fixture.bin" },
    {
      prepare: () => Effect.void,
      transcribe: () =>
        Effect.sync(() =>
          JSON.stringify({
            result: { language: "fr" },
            transcription: (results[transcriptions++] ?? []).map((text) => ({ text }))
          })
        )
    }
  )
  const answer = Layer.succeed(AnswerGeneration, {
    capabilities: { languages: ["ru", "fr", "en"], output: "text-deltas" },
    generate: () => {
      answerCalls += 1
      return Stream.make({ kind: "Delta", text: "Bonjour", languageSpans: [] }, { kind: "Completed" })
    }
  })
  return withVoiceOutput(
    (transport) =>
      Effect.gen(function* () {
        const voice = yield* Voice
        const conversation = yield* Conversation
        const join = yield* voice.start(startVoiceRequest())
        for (let utterance = 0; utterance < 2; utterance++) {
          yield* input.segment(transport)
          let snapshot = yield* voice.snapshot(join.sessionId, 0)
          for (
            let attempt = 0;
            snapshot.events.filter((event) => event.kind === "Discarded").length < utterance + 1 && attempt < 200;
            attempt++
          ) {
            yield* Effect.sleep(5)
            snapshot = yield* voice.snapshot(join.sessionId, 0)
          }
          expect(snapshot.events.filter((event) => event.kind === "Discarded")).toHaveLength(utterance + 1)
          expect(snapshot.pending).toEqual([])
          expect((yield* conversation.page({ limit: 100 })).messages).toEqual([])
          expect(answerCalls).toBe(0)
        }
        yield* input.segment(transport)
        let current = yield* conversation.currentTurn()
        for (let attempt = 0; (current == null || answerCalls === 0) && attempt < 200; attempt++) {
          yield* Effect.sleep(5)
          current = yield* conversation.currentTurn()
        }
        expect(current?.input.text).toBe("Bonjour Hello")
        expect(current?.input.detectedLanguage).toBe("fr")
        expect(current?.input.languageSpans).toEqual([])
        expect(answerCalls).toBe(1)
        expect(transcriptions).toBe(3)
        expect(transport.captured).toEqual([])
        yield* voice.end(join.sessionId)
      }),
    fakeSynthesisLayer(),
    answer,
    recognition,
    undefined,
    undefined,
    input.layer
  )
})
