import { withCompletedVoiceOutput } from "./voice-output-completion-fixture.ts"
import { Deferred, Effect, Layer, Stream } from "effect"
import { expect, it } from "vitest"
import { AnswerGeneration } from "../src/answer-generation/index.ts"
import type { AnswerEvent } from "../src/answer-generation/index.ts"
import { SpeechSynthesis, fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import { Conversation } from "../src/conversation/index.ts"
import { Voice } from "../src/voice/index.ts"
import { startVoiceRequest } from "./voice-admission-fixture.ts"
import { outputInput, withVoiceOutput, waitForOutput } from "./voice-output-fixture.ts"

const recordingSynthesis = (spoken: { text: string; language: string }[]) =>
  Layer.effect(
    SpeechSynthesis,
    Effect.gen(function* () {
      const real = yield* SpeechSynthesis
      return SpeechSynthesis.of({
        capabilities: real.capabilities,
        synthesize: (request) => {
          spoken.push({ text: request.text, language: request.language })
          return real.synthesize(request)
        }
      })
    })
  ).pipe(Layer.provide(fakeSynthesisLayer({ delayMillis: 0 })))

it("delivers a complete multilingual reply through bounded scalar-safe synthesis requests without losing its tail", () => {
  const first = `${"x".repeat(799)}😀fin. `
  const second = "Bonjour! ".repeat(180)
  const third = "Привет! ".repeat(180)
  const text = first + second + third
  const spans = [
    { language: "en", start: 0, end: first.length },
    { language: "fr", start: first.length, end: first.length + second.length },
    { language: "ru", start: first.length + second.length, end: text.length }
  ]
  const spoken: { text: string; language: string }[] = []
  const answer = Layer.succeed(AnswerGeneration, {
    capabilities: { languages: ["en", "fr", "ru"], output: "text-deltas" },
    generate: () => Stream.make({ kind: "Delta", text, languageSpans: spans }, { kind: "Completed" })
  })
  return withCompletedVoiceOutput(
    (_transport, completed) =>
      Effect.gen(function* () {
        const voice = yield* Voice
        const conversation = yield* Conversation
        const join = yield* voice.start(startVoiceRequest())
        yield* conversation.send(outputInput)
        const waiting = (yield* waitForOutput(voice, join.sessionId, "AwaitingReady")).output
        if (waiting?.manifest == null) throw new Error("Missing publication")
        yield* voice.ready(join.sessionId, {
          responseId: waiting.responseId,
          outputEpoch: waiting.outputEpoch,
          trackSid: waiting.manifest.trackSid
        })
        expect((yield* completed(waiting)).status).toBe("Delivered")
        expect(
          spoken
            .map((phrase) => phrase.text)
            .join("")
            .replaceAll(/\s/gu, "")
        ).toBe(text.replaceAll(/\s/gu, ""))
        for (const phrase of spoken) {
          expect(phrase.text.length).toBeLessThanOrEqual(800)
          expect(() => encodeURI(phrase.text)).not.toThrow()
        }
        expect(spoken.map((phrase) => phrase.language)).toEqual(expect.arrayContaining(["en", "fr", "ru"]))
        expect((yield* conversation.reply(outputInput.deliveryId)).receipt?.text).toBe(text)
      }),
    recordingSynthesis(spoken),
    answer
  )
})

it("waits for a complete phrase and speaks growing authoritative text once", async () => {
  const release = await Effect.runPromise(Deferred.make<void>())
  const prefixEmitted = await Effect.runPromise(Deferred.make<void>())
  const spoken: { text: string; language: string }[] = []
  const answer = Layer.succeed(AnswerGeneration, {
    capabilities: { languages: ["en", "fr", "ru"], output: "text-deltas" },
    generate: () =>
      Stream.fromIterable<AnswerEvent>([{ kind: "Delta", text: "hello", languageSpans: [] }]).pipe(
        Stream.concat(Stream.fromEffect(Deferred.succeed(prefixEmitted, undefined)).pipe(Stream.drain)),
        Stream.concat(Stream.fromEffect(Deferred.await(release)).pipe(Stream.drain)),
        Stream.concat(
          Stream.fromIterable<AnswerEvent>([
            { kind: "Delta", text: " world.", languageSpans: [] },
            { kind: "Completed" }
          ])
        )
      )
  })
  await withVoiceOutput(
    () =>
      Effect.gen(function* () {
        const voice = yield* Voice
        const conversation = yield* Conversation
        const join = yield* voice.start(startVoiceRequest())
        yield* conversation.send(outputInput)
        yield* Deferred.await(prefixEmitted).pipe(Effect.timeout("2 seconds"))
        const waiting = (yield* waitForOutput(voice, join.sessionId, "AwaitingReady")).output
        if (waiting?.manifest == null) throw new Error("Missing publication")
        yield* voice.ready(join.sessionId, {
          responseId: waiting.responseId,
          outputEpoch: waiting.outputEpoch,
          trackSid: waiting.manifest.trackSid
        })
        expect((yield* waitForOutput(voice, join.sessionId, "Playing")).output?.status).toBe("Playing")
        expect(spoken).toEqual([])
        expect((yield* conversation.reply(outputInput.deliveryId)).text).toBe("hello")
        yield* Deferred.succeed(release, undefined)
        expect((yield* waitForOutput(voice, join.sessionId, "Delivered")).output?.status).toBe("Delivered")
        expect(spoken).toEqual([{ text: "hello world.", language: "en" }])
        expect((yield* conversation.reply(outputInput.deliveryId)).receipt?.text).toBe("hello world.")
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined))),
    recordingSynthesis(spoken),
    answer
  )
})
