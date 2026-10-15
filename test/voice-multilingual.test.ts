import { Effect, Layer, Stream } from "effect"
import { expect, it } from "vitest"
import { Voice } from "../src/voice/index.ts"
import { Conversation } from "../src/conversation/index.ts"
import { AnswerGeneration, fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { SpeechSynthesis, fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import { SpeechRecognition, fakeRecognitionLayer } from "../src/speech-recognition/index.ts"
import { withVoiceOutput, waitForOutput, outputInput } from "./voice-output-fixture.ts"
import { startVoiceRequest } from "./voice-admission-fixture.ts"
const recordingSynthesis = (requests: { language: string; text: string }[]) =>
  Layer.effect(
    SpeechSynthesis,
    Effect.gen(function* () {
      const provider = yield* SpeechSynthesis
      return SpeechSynthesis.of({
        ...provider,
        synthesize: (request) => {
          requests.push({ language: request.language, text: request.text })
          return provider.synthesize(request)
        }
      })
    })
  ).pipe(Layer.provide(fakeSynthesisLayer({ delayMillis: 0 })))
const deliver = (voice: Voice["Service"], sessionId: string) =>
  Effect.gen(function* () {
    const waiting = (yield* waitForOutput(voice, sessionId, "AwaitingReady")).output
    if (waiting?.manifest == null) throw new Error("Expected identified audio readiness")
    yield* voice.ready(sessionId, {
      responseId: waiting.responseId,
      outputEpoch: waiting.outputEpoch,
      trackSid: waiting.manifest.trackSid
    })
    expect((yield* waitForOutput(voice, sessionId, "Delivered")).output?.status).toBe("Delivered")
  })
it("runs RU to FR to EN and mixed speech through one Conversation and one voice room", () => {
  const requests: { language: string; text: string }[] = []
  return withVoiceOutput(
    (transport) =>
      Effect.gen(function* () {
        const voice = yield* Voice
        const conversation = yield* Conversation
        const joined = yield* voice.start(startVoiceRequest())
        for (let index = 0; index < 4; index++) {
          yield* transport.segment
          yield* deliver(voice, joined.sessionId)
        }
        const messages = (yield* conversation.page({ limit: 100 })).messages
        expect(
          messages
            .filter((message) => message.role === "user")
            .map((message) => [message.text, message.languageSpans.map((span) => span.language)])
        ).toEqual([
          ["Привет", ["ru"]],
          ["Bonjour", ["fr"]],
          ["Hello", ["en"]],
          ["Bonjour Hello", ["fr", "en"]]
        ])
        expect(messages.filter((message) => message.role === "assistant").map((message) => message.text)).toEqual([
          "Это демонстрационный ответ.",
          "Ceci est une réponse fictive.",
          "This is a fixture reply.",
          "Ceci est une réponse fictive."
        ])
        expect(requests.map((request) => request.language)).toEqual(["ru", "fr", "en", "fr"])
        expect(transport.opens()).toBe(1)
        expect(transport.captured.length).toBeGreaterThan(0)
      }),
    recordingSynthesis(requests)
  )
})
it("uses Japanese from matching declared capabilities without redesigning a session", () => {
  const requests: { language: string; text: string }[] = []
  return withVoiceOutput(
    (transport) =>
      Effect.gen(function* () {
        const voice = yield* Voice
        const conversation = yield* Conversation
        const join = yield* voice.start(startVoiceRequest())
        yield* transport.segment
        yield* deliver(voice, join.sessionId)
        const messages = (yield* conversation.page({ limit: 100 })).messages
        expect(messages[0]?.text).toBe("こんにちは")
        expect(messages[0]?.languageSpans).toEqual([{ language: "ja", start: 0, end: 5 }])
        expect(messages[1]?.text).toBe("これはデモの返答です。")
        expect(requests.map((request) => request.language)).toEqual(["ja"])
        expect((yield* voice.languages()).allowedLanguages).toEqual(["ja"])
      }),
    recordingSynthesis(requests),
    fakeAnswerLayer(0),
    fakeRecognitionLayer(),
    { allowedLanguages: ["ja"] }
  )
})
it("splits mixed reply phrases at language boundaries and preserves a scalar-safe uncovered gap", () => {
  const requests: { language: string; text: string }[] = []
  const text = "Bonjour 😀 Hello."
  const answer = Layer.succeed(AnswerGeneration, {
    capabilities: { languages: ["ru", "fr", "en", "ja"], output: "text-deltas" },
    generate: () =>
      Stream.fromIterable([
        {
          kind: "Delta",
          text,
          languageSpans: [
            { language: "fr", start: 0, end: 7 },
            { language: "en", start: 11, end: text.length }
          ]
        },
        { kind: "Completed" }
      ])
  })
  return withVoiceOutput(
    () =>
      Effect.gen(function* () {
        const voice = yield* Voice
        const conversation = yield* Conversation
        const join = yield* voice.start(startVoiceRequest())
        yield* conversation.send(outputInput)
        yield* deliver(voice, join.sessionId)
        expect(requests).toEqual([
          { language: "fr", text: "Bonjour" },
          { language: "en", text: "😀" },
          { language: "en", text: "Hello." }
        ])
        expect((yield* conversation.currentTurn())?.reply.text).toBe(text)
      }),
    recordingSynthesis(requests),
    answer
  )
})
for (const metadata of [
  { name: "out-of-set detected tag", spans: [{ language: "de", start: 0, end: 7 }] },
  { name: "surrogate-splitting span", spans: [{ language: "en", start: 1, end: 7 }] }
])
  it(`rejects ${metadata.name} at the outer recognition boundary without appending input`, () => {
    const recognition = Layer.effect(
      SpeechRecognition,
      Effect.gen(function* () {
        const provider = yield* SpeechRecognition
        return SpeechRecognition.of({
          ...provider,
          recognize: (request) =>
            Stream.succeed({ kind: "Final", utteranceId: request.utteranceId, text: "😀wrong", spans: metadata.spans })
        })
      })
    ).pipe(Layer.provide(fakeRecognitionLayer()))
    return withVoiceOutput(
      (transport) =>
        Effect.gen(function* () {
          const voice = yield* Voice
          const conversation = yield* Conversation
          const join = yield* voice.start(startVoiceRequest())
          yield* transport.segment
          let snapshot = yield* voice.snapshot(join.sessionId, 0)
          for (let index = 0; !snapshot.events.some((event) => event.kind === "Error") && index < 100; index++) {
            yield* Effect.sleep(5)
            snapshot = yield* voice.snapshot(join.sessionId, 0)
          }
          expect(snapshot.events.find((event) => event.kind === "Error")?.code).toBe("InvalidRecognition")
          expect(snapshot.pending).toEqual([])
          expect((yield* conversation.page({ limit: 100 })).messages).toEqual([])
          expect(transport.captured).toEqual([])
        }),
      fakeSynthesisLayer(),
      fakeAnswerLayer(0),
      recognition
    )
  })
it("ignores wrong-utterance and post-Final recognition events without another append or tentative revival", () => {
  const recognition = Layer.effect(
    SpeechRecognition,
    Effect.gen(function* () {
      const provider = yield* SpeechRecognition
      return SpeechRecognition.of({
        ...provider,
        recognize: (request) =>
          Stream.fromIterable([
            { kind: "Final", utteranceId: crypto.randomUUID(), text: "Wrong identity", spans: [] },
            {
              kind: "Final",
              utteranceId: request.utteranceId,
              text: "Only admitted input",
              spans: [{ language: "en", start: 0, end: 19 }]
            },
            { kind: "Interim", utteranceId: request.utteranceId, text: "Late tentative" },
            { kind: "Final", utteranceId: request.utteranceId, text: "Late replacement", spans: [] }
          ])
      })
    })
  ).pipe(Layer.provide(fakeRecognitionLayer()))
  return withVoiceOutput(
    (transport) =>
      Effect.gen(function* () {
        const voice = yield* Voice
        const conversation = yield* Conversation
        const join = yield* voice.start(startVoiceRequest())
        yield* transport.segment
        yield* deliver(voice, join.sessionId)
        const snapshot = yield* voice.snapshot(join.sessionId, 0)
        expect(snapshot.events.filter((event) => event.kind === "Final").map((event) => event.text)).toEqual([
          "Only admitted input"
        ])
        expect(snapshot.events.filter((event) => event.kind === "Interim")).toEqual([])
        expect(
          (yield* conversation.page({ limit: 100 })).messages
            .filter((message) => message.role === "user")
            .map((message) => message.text)
        ).toEqual(["Only admitted input"])
      }),
    fakeSynthesisLayer({ delayMillis: 0 }),
    fakeAnswerLayer(0),
    recognition
  )
})
it("drains a collected reply larger than the staging window without truncation or duplicate speech", () => {
  const requests: { language: string; text: string }[] = []
  const text = "Bounded reply ".repeat(130)
  const answer = Layer.succeed(AnswerGeneration, {
    capabilities: { languages: ["ru", "fr", "en", "ja"], output: "text-deltas" },
    generate: () =>
      Stream.fromIterable([
        { kind: "Delta", text, languageSpans: [{ language: "en", start: 0, end: text.length }] },
        { kind: "Completed" }
      ])
  })
  return withVoiceOutput(
    (transport) =>
      Effect.gen(function* () {
        const voice = yield* Voice
        const conversation = yield* Conversation
        const join = yield* voice.start(startVoiceRequest())
        yield* conversation.send(outputInput)
        const waiting = (yield* waitForOutput(voice, join.sessionId, "AwaitingReady")).output
        if (waiting?.manifest == null) throw new Error("Expected bounded publication")
        yield* voice.ready(join.sessionId, {
          responseId: waiting.responseId,
          outputEpoch: waiting.outputEpoch,
          trackSid: waiting.manifest.trackSid
        })
        expect((yield* waitForOutput(voice, join.sessionId, "Delivered")).output?.status).toBe("Delivered")
        const turn = yield* conversation.currentTurn()
        expect(turn?.reply.state).toBe("Completed")
        expect(turn?.reply.text).toBe(text)
        expect(turn?.reply.receipt?.text).toBe(text)
        expect(turn?.reply.receipt?.outcome).toBe("completed")
        expect(requests.length).toBeGreaterThan(2)
        expect(requests.every((request) => request.language === "en" && request.text.length <= 800)).toBe(true)
        expect(
          requests
            .map((request) => request.text)
            .join(" ")
            .trim()
            .split(/\s+/u)
        ).toEqual(text.trim().split(/\s+/u))
        expect(transport.captured.length).toBeGreaterThan(0)
        expect((yield* conversation.page({ limit: 100 })).messages).toHaveLength(2)
      }),
    recordingSynthesis(requests),
    answer
  )
})
