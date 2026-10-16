import { Effect, Layer, Queue, Stream } from "effect"
import { expect, it } from "vitest"
import { AnswerGeneration } from "../src/answer-generation/index.ts"
import { Conversation } from "../src/conversation/index.ts"
import { SpeechRecognition, RecognitionFailed } from "../src/speech-recognition/index.ts"
import type { RecognitionRequest, RecognitionEvent } from "../src/speech-recognition/index.ts"
import { fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import { Voice, SpeechActivity, fakeSpeechActivityLayer } from "../src/voice/index.ts"
import { startVoiceRequest } from "./voice-admission-fixture.ts"
import { withVoiceOutput } from "./voice-output-fixture.ts"
import type { voiceTransportFixture } from "./voice-fixture.ts"

type Transport = ReturnType<typeof voiceTransportFixture>
const waiting = Layer.succeed(AnswerGeneration, {
  capabilities: { languages: ["ru", "fr", "en"], output: "text-deltas" },
  generate: () => Stream.never
})
const controlledRecognition = () => {
  const requests: {
    request: RecognitionRequest
    finish: (text: string, language?: string) => void
    fail: () => void
  }[] = []
  const layer = Layer.succeed(SpeechRecognition, {
    capabilities: {
      input: "supplied-audio",
      languages: ["ru", "fr", "en"],
      encoding: "pcm-s16le",
      sampleRateHz: 16000,
      channels: 1,
      maximumSampleFrames: 240000
    },
    recognize: (request) =>
      Stream.fromEffect(
        Effect.tryPromise({
          try: () =>
            new Promise<RecognitionEvent>((resolve, reject) => {
              requests.push({
                request,
                finish: (text, language = "en") =>
                  resolve({
                    kind: "Final",
                    utteranceId: request.utteranceId,
                    text,
                    detectedLanguage: language,
                    spans: text.length === 0 ? [] : [{ start: 0, end: text.length, language }]
                  }),
                fail: () => reject(new Error("controlled chunk failure"))
              })
            }),
          catch: () => new RecognitionFailed({ message: "controlled chunk failure" })
        })
      )
  })
  return { layer, requests }
}
const classifiedActivity = Effect.gen(function* () {
  const completed = yield* Queue.unbounded<void>()
  const layer = Layer.effect(
    SpeechActivity,
    Effect.gen(function* () {
      const real = yield* SpeechActivity
      return SpeechActivity.of({
        open: () =>
          real
            .open()
            .pipe(
              Effect.map((stream) => ({
                reset: () => stream.reset(),
                push: (frame) => stream.push(frame).pipe(Effect.tap(() => Queue.offer(completed, undefined)))
              }))
            )
      })
    })
  ).pipe(Layer.provide(fakeSpeechActivityLayer))
  return { layer, completed }
})
type ClassifiedActivity = Effect.Success<typeof classifiedActivity>
const frames = (transport: Transport, activity: ClassifiedActivity, count: number, sample = 1200) =>
  Effect.forEach(
    Array.from({ length: count }),
    () =>
      transport
        .send(transport.audio(sample))
        .pipe(Effect.andThen(Queue.take(activity.completed)), Effect.timeout("2 seconds")),
    { discard: true }
  )
const settle = Effect.sleep(30)
const waitRequests = (provider: ReturnType<typeof controlledRecognition>, count: number) =>
  Effect.gen(function* () {
    for (let i = 0; provider.requests.length < count && i < 200; i++) yield* Effect.sleep(5)
    expect(provider.requests).toHaveLength(count)
  })
const page = () => Effect.flatMap(Conversation, (conversation) => conversation.page({ limit: 100 }))
const waitAccepted = (voice: Voice["Service"], sessionId: string) =>
  Effect.gen(function* () {
    let snapshot = yield* voice.snapshot(sessionId, 0)
    for (let poll = 0; !snapshot.events.some((event) => event.kind === "Accepted") && poll < 200; poll++) {
      yield* Effect.sleep(5)
      snapshot = yield* voice.snapshot(sessionId, 0)
    }
    expect(snapshot.events.some((event) => event.kind === "Accepted")).toBe(true)
  })

it("orders completed chunks, shifts multilingual spans and accepts only once after an empty final chunk", async () => {
  const activity = await Effect.runPromise(classifiedActivity)
  const provider = controlledRecognition()
  return withVoiceOutput(
    (transport) =>
      Effect.gen(function* () {
        const voice = yield* Voice
        const join = yield* voice.start(startVoiceRequest())
        yield* frames(transport, activity, 1010)
        yield* waitRequests(provider, 2)
        expect(provider.requests.every(({ request }) => request.audio.sampleFrames === 160000)).toBe(true)
        provider.requests[1]?.finish("pain", "fr")
        yield* settle
        expect((yield* page()).messages).toEqual([])
        yield* frames(transport, activity, 50, 0)
        yield* waitRequests(provider, 3)
        provider.requests[2]?.finish("")
        yield* settle
        expect((yield* page()).messages).toEqual([])
        provider.requests[0]?.finish("bread")
        yield* waitAccepted(voice, join.sessionId)
        const messages = (yield* page()).messages
        expect(messages.map((message) => message.text)).toEqual(["bread pain"])
        expect(messages[0]?.languageSpans).toEqual([
          { language: "en", start: 0, end: 5 },
          { language: "fr", start: 6, end: 10 }
        ])
        expect(messages[0]?.detectedLanguage).toBeNull()
        expect(transport.published.filter((event) => event.kind === "Final")).toHaveLength(1)
        yield* frames(transport, activity, 60, 0)
        expect((yield* (yield* Conversation).currentTurn())?.reply.state).toBe("Waiting")
        yield* voice.end(join.sessionId)
      }),
    fakeSynthesisLayer(),
    waiting,
    provider.layer,
    undefined,
    undefined,
    activity.layer
  )
})

it("keeps resumed speech provisional when the previous quiet chunk finishes recognition", async () => {
  const activity = await Effect.runPromise(classifiedActivity)
  const provider = controlledRecognition()
  return withVoiceOutput(
    (transport) =>
      Effect.gen(function* () {
        const voice = yield* Voice
        const join = yield* voice.start(startVoiceRequest())
        yield* frames(transport, activity, 10)
        yield* frames(transport, activity, 50, 0)
        yield* waitRequests(provider, 1)
        yield* frames(transport, activity, 10)
        provider.requests[0]?.finish("first")
        yield* settle
        expect((yield* page()).messages).toEqual([])
        yield* frames(transport, activity, 50, 0)
        yield* waitRequests(provider, 2)
        provider.requests[1]?.finish("second")
        yield* waitAccepted(voice, join.sessionId)
        expect((yield* page()).messages.map((message) => message.text)).toEqual(["first second"])
        yield* voice.end(join.sessionId)
      }),
    fakeSynthesisLayer(),
    waiting,
    provider.layer,
    undefined,
    undefined,
    activity.layer
  )
})

it("fails the whole incomplete turn once, ignores stale chunk errors and suppresses its spoken suffix", async () => {
  const activity = await Effect.runPromise(classifiedActivity)
  const provider = controlledRecognition()
  return withVoiceOutput(
    (transport) =>
      Effect.gen(function* () {
        const voice = yield* Voice
        const join = yield* voice.start(startVoiceRequest())
        yield* frames(transport, activity, 1010)
        yield* waitRequests(provider, 2)
        provider.requests[0]?.fail()
        yield* settle
        provider.requests[1]?.fail()
        yield* frames(transport, activity, 10)
        yield* frames(transport, activity, 50, 0)
        yield* settle
        expect((yield* page()).messages).toEqual([])
        expect(transport.published.filter((event) => event.kind === "Error")).toHaveLength(1)
        yield* frames(transport, activity, 10)
        yield* frames(transport, activity, 50, 0)
        yield* waitRequests(provider, 3)
        provider.requests[2]?.finish("fresh")
        yield* waitAccepted(voice, join.sessionId)
        expect((yield* page()).messages.map((message) => message.text)).toEqual(["fresh"])
        yield* voice.end(join.sessionId)
      }),
    fakeSynthesisLayer(),
    waiting,
    provider.layer,
    undefined,
    undefined,
    activity.layer
  )
})

it("fences both late recognition success and failure when muted", async () => {
  const activity = await Effect.runPromise(classifiedActivity)
  const provider = controlledRecognition()
  return withVoiceOutput(
    (transport) =>
      Effect.gen(function* () {
        const voice = yield* Voice
        const join = yield* voice.start(startVoiceRequest())
        yield* frames(transport, activity, 1010)
        yield* waitRequests(provider, 2)
        yield* voice.mute(join.sessionId, true)
        provider.requests[0]?.finish("stale")
        provider.requests[1]?.fail()
        yield* settle
        expect((yield* page()).messages).toEqual([])
        expect(transport.published.filter((event) => event.kind === "Error" || event.kind === "Final")).toEqual([])
        yield* voice.end(join.sessionId)
      }),
    fakeSynthesisLayer(),
    waiting,
    provider.layer,
    undefined,
    undefined,
    activity.layer
  )
})

it("rejects a recognition stream without Final instead of silently accepting its incomplete turn", async () => {
  const activity = await Effect.runPromise(classifiedActivity)
  const recognition = Layer.succeed(SpeechRecognition, {
    capabilities: {
      input: "supplied-audio",
      languages: ["ru", "fr", "en"],
      encoding: "pcm-s16le",
      sampleRateHz: 16000,
      channels: 1,
      maximumSampleFrames: 240000
    },
    recognize: () => Stream.empty
  })
  return withVoiceOutput(
    (transport) =>
      Effect.gen(function* () {
        const voice = yield* Voice
        const join = yield* voice.start(startVoiceRequest())
        yield* frames(transport, activity, 3)
        yield* frames(transport, activity, 50, 0)
        yield* settle
        expect((yield* page()).messages).toEqual([])
        expect(transport.published.filter((event) => event.kind === "Error")).toHaveLength(1)
        yield* voice.end(join.sessionId)
      }),
    fakeSynthesisLayer(),
    waiting,
    recognition,
    undefined,
    undefined,
    activity.layer
  )
})
