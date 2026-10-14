import { it } from "@effect/vitest"
import { Effect, Fiber, Ref, Stream } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vitest"
import {
  SpeechSynthesis,
  fakeSynthesisLayer,
  type SynthesisRequest,
  type FakeSynthesisConfiguration
} from "../src/speech-synthesis/index.ts"

const request = {
  responseId: "11111111-1111-4111-8111-111111111111",
  phraseId: "22222222-2222-4222-8222-222222222222",
  language: "fr",
  text: "Bonjour"
} as const

it.effect("synthesizes one bounded supplied phrase as valid ordered PCM and one terminal", () =>
  Effect.gen(function* () {
    const synthesis = yield* SpeechSynthesis
    const events = yield* Stream.runCollect(synthesis.synthesize(request))
    expect(events.map((event) => [event.kind, event.sequence])).toEqual([
      ["Chunk", 0],
      ["Chunk", 1],
      ["Completed", 2]
    ])
    const first = events[0]
    expect(first?.responseId).toBe(request.responseId)
    expect(first?.phraseId).toBe(request.phraseId)
    if (first?.kind === "Chunk") {
      expect(first.audio.sampleFrames).toBe(1200)
      expect(first.audio.bytes.length).toBe(2400)
      expect([...first.audio.bytes.slice(0, 8)]).toEqual([232, 3, 232, 3, 232, 3, 232, 3])
      expect(first.audio.sampleRateHz).toBe(24000)
    }
  }).pipe(Effect.provide(fakeSynthesisLayer({ sampleFrames: 1500, amplitude: 1000, delayMillis: 0 })))
)

it.effect("cancellation prevents queued PCM and terminal output from returning", () =>
  Effect.gen(function* () {
    const synthesis = yield* SpeechSynthesis
    const observed = yield* Ref.make<ReadonlyArray<string>>([])
    const task = yield* Effect.forkChild(
      synthesis
        .synthesize(request)
        .pipe(Stream.runForEach((event) => Ref.update(observed, (events) => [...events, event.kind])))
    )
    yield* TestClock.adjust(10)
    expect(yield* Ref.get(observed)).toEqual(["Chunk"])
    yield* Fiber.interrupt(task)
    yield* TestClock.adjust(1000)
    expect(yield* Ref.get(observed)).toEqual(["Chunk"])
  }).pipe(Effect.provide(fakeSynthesisLayer({ sampleFrames: 3600, delayMillis: 10 })))
)

it.effect("rejects impossible failure scripts rather than failing at a different chunk", () =>
  Effect.gen(function* () {
    const synthesis = yield* SpeechSynthesis
    return yield* Stream.runCollect(synthesis.synthesize(request))
  }).pipe(
    Effect.provide(fakeSynthesisLayer({ sampleFrames: 1200, failureAfterChunks: 2, delayMillis: 0 })),
    Effect.result,
    Effect.map((result) => {
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure.message).toBe("Invalid fake synthesis configuration")
    })
  )
)

it.effect("rejects unsupported languages and invalid phrase identities or lengths before audio", () =>
  Effect.gen(function* () {
    const synthesis = yield* SpeechSynthesis
    for (const invalid of [
      { ...request, language: "ja" },
      { ...request, text: "" },
      { ...request, text: "a".repeat(801) },
      { ...request, responseId: "invalid" }
    ] satisfies ReadonlyArray<SynthesisRequest>) {
      const result = yield* synthesis.synthesize(invalid).pipe(Stream.runCollect, Effect.result)
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure._tag).toBe("SpeechSynthesisFailed")
    }
  }).pipe(Effect.provide(fakeSynthesisLayer({ delayMillis: 0 })))
)

it.effect("publishes only earlier chunks before typed scripted failure", () =>
  Effect.gen(function* () {
    const synthesis = yield* SpeechSynthesis
    const observed = yield* Ref.make<ReadonlyArray<string>>([])
    const result = yield* synthesis.synthesize(request).pipe(
      Stream.runForEach((event) => Ref.update(observed, (events) => [...events, event.kind])),
      Effect.result
    )
    expect(yield* Ref.get(observed)).toEqual(["Chunk"])
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure.message).toBe("Scripted synthesis failure")
  }).pipe(Effect.provide(fakeSynthesisLayer({ sampleFrames: 3600, failureAfterChunks: 1, delayMillis: 0 })))
)

it.effect("accepts Japanese only with explicit capability configuration and bounds total audio", () =>
  Effect.gen(function* () {
    const synthesis = yield* SpeechSynthesis
    expect(synthesis.capabilities.languages).toEqual(["ja"])
    const events = yield* Stream.runCollect(synthesis.synthesize({ ...request, language: "ja" }))
    expect(events.length).toBe(201)
    expect(events.at(-1)).toEqual({
      kind: "Completed",
      responseId: request.responseId,
      phraseId: request.phraseId,
      sequence: 200
    })
    expect(events.reduce((sum, event) => sum + (event.kind === "Chunk" ? event.audio.sampleFrames : 0), 0)).toBe(240000)
  }).pipe(Effect.provide(fakeSynthesisLayer({ languages: ["ja"], sampleFrames: 240000, delayMillis: 0 })))
)

it.effect("fails invalid PCM configuration through the typed Layer failure channel", () =>
  Effect.gen(function* () {
    for (const configuration of [
      { amplitude: 32768 },
      { amplitude: 0 },
      { sampleFrames: 0 },
      { sampleFrames: 240001 },
      { delayMillis: -1 },
      { languages: ["en", "en"] }
    ] satisfies ReadonlyArray<FakeSynthesisConfiguration>) {
      const result = yield* Effect.gen(function* () {
        const synthesis = yield* SpeechSynthesis
        return yield* Stream.runCollect(synthesis.synthesize(request))
      }).pipe(Effect.provide(fakeSynthesisLayer(configuration)), Effect.result)
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure._tag).toBe("SpeechSynthesisFailed")
    }
  })
)
