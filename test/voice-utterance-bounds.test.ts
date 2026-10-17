import { Deferred, Effect, Layer, Queue, Stream } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import { SpeechRecognition, fakeRecognitionLayer } from "../src/speech-recognition/index.ts"
import { Voice } from "../src/voice/index.ts"
import type { LanguageSpan } from "../src/language/index.ts"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import { startVoiceRequest } from "./voice-admission-fixture.ts"
import { classifiedVoiceInput, withVoiceOutput } from "./voice-output-fixture.ts"

type Payload = { readonly text: string; readonly spans: readonly LanguageSpan[] }
const controlledRecognition = Effect.gen(function* () {
  const requests = yield* Queue.unbounded<Deferred.Deferred<Payload>>()
  const started: number[] = []
  const layer = Layer.effect(
    SpeechRecognition,
    Effect.gen(function* () {
      const real = yield* SpeechRecognition
      return SpeechRecognition.of({
        ...real,
        recognize: (request) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const result = yield* Deferred.make<Payload>()
              started.push(request.audio.sampleFrames)
              yield* Queue.offer(requests, result)
              return Stream.fromEffect(Deferred.await(result)).pipe(
                Stream.map((payload) => ({
                  ...payload,
                  kind: "Final" as const,
                  utteranceId: request.utteranceId,
                  detectedLanguage: "en"
                }))
              )
            })
          )
      })
    })
  ).pipe(Layer.provide(fakeRecognitionLayer()))
  return { requests, started, layer }
})
const waitForError = (voice: Voice["Service"], sessionId: string) =>
  Effect.gen(function* () {
    let snapshot = yield* voice.snapshot(sessionId, 0)
    for (let attempt = 0; !snapshot.events.some((event) => event.kind === "Error") && attempt < 200; attempt++) {
      yield* Effect.sleep(5)
      snapshot = yield* voice.snapshot(sessionId, 0)
    }
    expect(snapshot.events.filter((event) => event.kind === "Error").map((event) => event.code)).toEqual([
      "RecognitionFailed"
    ])
    expect(snapshot.events.some((event) => event.kind === "Final" || event.kind === "Accepted")).toBe(false)
  })
const freshAccepted = (provider: Effect.Success<typeof controlledRecognition>, conversation: Conversation["Service"]) =>
  Effect.gen(function* () {
    const result = yield* Queue.take(provider.requests).pipe(Effect.timeout("2 seconds"))
    yield* Deferred.succeed(result, { text: "Fresh after capacity failure", spans: [] })
    let page = yield* conversation.page({ limit: 100 })
    for (let attempt = 0; !page.messages.some((message) => message.role === "user") && attempt < 200; attempt++) {
      yield* Effect.sleep(5)
      page = yield* conversation.page({ limit: 100 })
    }
    expect(page.messages.filter((message) => message.role === "user").map((message) => message.text)).toEqual([
      "Fresh after capacity failure"
    ])
  })

it("reserves only two concurrent recognitions and rejects chunk thirty-one without admitting a prefix", async () => {
  const input = await Effect.runPromise(classifiedVoiceInput())
  const provider = await Effect.runPromise(controlledRecognition)
  await withVoiceOutput(
    (transport) =>
      Effect.gen(function* () {
        const voice = yield* Voice
        const conversation = yield* Conversation
        const join = yield* voice.start(startVoiceRequest())
        // Quiet creates a chunk; withheld results keep all thirty chunks in one provisional turn.
        for (let chunk = 0; chunk < 30; chunk++) yield* input.segment(transport)
        expect(provider.started).toEqual([16960, 16960])
        expect((yield* voice.snapshot(join.sessionId, 0)).events.some((event) => event.kind === "Error")).toBe(false)
        expect((yield* conversation.page({ limit: 100 })).messages).toEqual([])
        yield* Queue.take(provider.requests)
        yield* Queue.take(provider.requests)
        yield* input.segment(transport)
        yield* waitForError(voice, join.sessionId)
        expect((yield* conversation.page({ limit: 100 })).messages).toEqual([])
        yield* input.segment(transport)
        yield* freshAccepted(provider, conversation)
        expect(provider.started).toEqual([16960, 16960, 16960])
        yield* voice.end(join.sessionId)
      }),
    fakeSynthesisLayer(),
    fakeAnswerLayer(0),
    provider.layer,
    undefined,
    undefined,
    input.layer
  )
})

const spans = (count: number): readonly LanguageSpan[] =>
  Array.from({ length: count }, (_, index) => ({ language: "en", start: index * 2, end: index * 2 + 1 }))
for (const scenario of [
  {
    name: "100002 text-budget units",
    first: { text: "a".repeat(50000), spans: [] },
    second: { text: "b".repeat(50000), spans: [] }
  },
  {
    name: "the empty final's extra text-budget unit",
    first: { text: "a".repeat(99999), spans: [] },
    second: { text: "", spans: [] }
  },
  {
    name: "1001 aggregate language spans",
    first: { text: "a".repeat(1002), spans: spans(501) },
    second: { text: "b".repeat(1000), spans: spans(500) }
  }
])
  it(`rejects ${scenario.name} for the whole provisional turn and accepts fresh speech`, async () => {
    const input = await Effect.runPromise(classifiedVoiceInput())
    const provider = await Effect.runPromise(controlledRecognition)
    await withVoiceOutput(
      (transport) =>
        Effect.gen(function* () {
          const voice = yield* Voice
          const conversation = yield* Conversation
          const join = yield* voice.start(startVoiceRequest())
          yield* input.segment(transport)
          const first = yield* Queue.take(provider.requests).pipe(Effect.timeout("2 seconds"))
          yield* input.segment(transport)
          const second = yield* Queue.take(provider.requests).pipe(Effect.timeout("2 seconds"))
          yield* Deferred.succeed(first, scenario.first)
          yield* Deferred.succeed(second, scenario.second)
          yield* waitForError(voice, join.sessionId)
          expect((yield* conversation.page({ limit: 100 })).messages).toEqual([])
          yield* input.segment(transport)
          yield* freshAccepted(provider, conversation)
          yield* voice.end(join.sessionId)
        }),
      fakeSynthesisLayer(),
      fakeAnswerLayer(0),
      provider.layer,
      undefined,
      undefined,
      input.layer
    )
  })
