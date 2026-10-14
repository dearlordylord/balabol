import { it } from "@effect/vitest"
import { Cause, Effect, Exit, Fiber, Ref, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vitest"
import {
  type RecognitionEvent,
  RecognitionRequest,
  SpeechRecognition,
  fakeRecognitionLayer
} from "../src/speech-recognition/index.ts"

const request: RecognitionRequest = {
  utteranceId: "11111111-1111-4111-8111-111111111111",
  audio: { encoding: "pcm-s16le", sampleRateHz: 16000, channels: 1, sampleFrames: 2, bytes: new Uint8Array(4) },
  allowedLanguages: ["ru", "fr", "en"]
}
const config = {
  languages: request.allowedLanguages,
  scripts: [
    {
      events: [
        { kind: "Interim", text: "bon" },
        { kind: "Final", text: "bonjour", spans: [{ language: "fr", start: 0, end: 7 }] }
      ],
      delayMillis: 10,
      failure: null
    }
  ]
} satisfies Parameters<typeof fakeRecognitionLayer>[0]

it.effect("recognizes supplied audio as identified tentative then final events", () =>
  Effect.gen(function* () {
    const provider = yield* SpeechRecognition
    expect(provider.capabilities.input).toBe("supplied-audio")
    const task = yield* Effect.forkChild(Stream.runCollect(provider.recognize(request)))
    yield* TestClock.adjust(30)
    expect(yield* Fiber.join(task)).toEqual(
      config.scripts[0]?.events.map((event) => ({ ...event, utteranceId: request.utteranceId }))
    )
  }).pipe(Effect.provide(fakeRecognitionLayer(config)))
)

it.effect("cancellation prevents delayed recognition final from reappearing", () =>
  Effect.gen(function* () {
    const provider = yield* SpeechRecognition
    const observed = yield* Ref.make<ReadonlyArray<RecognitionEvent>>([])
    const task = yield* Effect.forkChild(
      provider
        .recognize(request)
        .pipe(Stream.runForEach((event) => Ref.update(observed, (events) => [...events, event])))
    )
    yield* TestClock.adjust(10)
    expect((yield* Ref.get(observed)).map((event) => event.kind)).toEqual(["Interim"])
    yield* Fiber.interrupt(task)
    yield* TestClock.adjust(1000)
    expect((yield* Ref.get(observed)).map((event) => event.kind)).toEqual(["Interim"])
    const exit = yield* Fiber.await(task)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
  }).pipe(Effect.provide(fakeRecognitionLayer(config)))
)

it.effect("rejects malformed audio and unsupported languages before publishing events", () =>
  Effect.gen(function* () {
    const provider = yield* SpeechRecognition
    for (const invalid of [
      { ...request, audio: { ...request.audio, sampleFrames: 3 } },
      { ...request, audio: { ...request.audio, sampleFrames: 240001 } },
      { ...request, allowedLanguages: ["ja"] },
      { ...request, allowedLanguages: ["fr", "fr"] },
      { ...request, utteranceId: "invalid" }
    ]) {
      const decoded = yield* Schema.decodeUnknownEffect(RecognitionRequest)(invalid).pipe(Effect.result)
      if (decoded._tag === "Success") {
        const result = yield* provider.recognize(decoded.success).pipe(Stream.runCollect, Effect.result)
        expect(result._tag).toBe("Failure")
      } else expect(decoded._tag).toBe("Failure")
    }
    const invalidBytes = yield* provider
      .recognize({ ...request, audio: { ...request.audio, bytes: new Uint8Array(3) } })
      .pipe(Stream.runCollect, Effect.result)
    expect(invalidBytes._tag).toBe("Failure")
  }).pipe(Effect.provide(fakeRecognitionLayer(config)))
)

it.effect("permits empty final and surfaces configured failure without completion", () =>
  Effect.gen(function* () {
    const provider = yield* SpeechRecognition
    expect(yield* Stream.runCollect(provider.recognize(request))).toEqual([
      { kind: "Final", text: "", spans: [], utteranceId: request.utteranceId }
    ])
    const result = yield* provider.recognize(request).pipe(Stream.runCollect, Effect.result)
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure.message).toBe("Unavailable fixture")
  }).pipe(
    Effect.provide(
      fakeRecognitionLayer({
        languages: ["fr", "en", "ru"],
        scripts: [
          { events: [{ kind: "Final", text: "", spans: [] }], delayMillis: 0, failure: null },
          { events: [{ kind: "Interim", text: "uncertain" }], delayMillis: 0, failure: "Unavailable fixture" }
        ]
      })
    )
  )
)

it.effect("rejects invalid final spans and late events at configuration acquisition", () =>
  Effect.gen(function* () {
    const provider = yield* SpeechRecognition
    return yield* Stream.runCollect(provider.recognize(request))
  }).pipe(
    Effect.provide(
      fakeRecognitionLayer({
        languages: ["fr"],
        scripts: [
          {
            events: [
              { kind: "Final", text: "bonjour", spans: [{ language: "fr", start: 0, end: 8 }] },
              { kind: "Interim", text: "late" }
            ],
            delayMillis: 0,
            failure: null
          }
        ]
      })
    ),
    Effect.result,
    Effect.map((result) => expect(result._tag).toBe("Failure"))
  )
)

it.effect("validates output languages against the supplied allowed set", () =>
  Effect.gen(function* () {
    const provider = yield* SpeechRecognition
    const result = yield* provider
      .recognize({ ...request, allowedLanguages: ["en"] })
      .pipe(Stream.runCollect, Effect.result)
    expect(result._tag).toBe("Failure")
  }).pipe(
    Effect.provide(
      fakeRecognitionLayer({ ...config, scripts: config.scripts.map((script) => ({ ...script, delayMillis: 0 })) })
    )
  )
)

it.effect("rejects incompatible PCM metadata through the public schema", () =>
  Effect.gen(function* () {
    for (const metadata of [{ encoding: "opus" }, { sampleRateHz: 48000 }, { channels: 2 }]) {
      const result = yield* Schema.decodeUnknownEffect(RecognitionRequest)({
        ...request,
        audio: { ...request.audio, ...metadata }
      }).pipe(Effect.result)
      expect(result._tag).toBe("Failure")
    }
  })
)

it.effect("permits Japanese only when the configured provider advertises it", () =>
  Effect.gen(function* () {
    const provider = yield* SpeechRecognition
    expect(provider.capabilities.languages).toEqual(["ja"])
    const events = yield* Stream.runCollect(provider.recognize({ ...request, allowedLanguages: ["ja"] }))
    expect(events.at(-1)).toEqual({
      kind: "Final",
      text: "こんにちは",
      spans: [{ language: "ja", start: 0, end: 5 }],
      utteranceId: request.utteranceId
    })
  }).pipe(
    Effect.provide(
      fakeRecognitionLayer({
        languages: ["ja"],
        scripts: [
          {
            events: [{ kind: "Final", text: "こんにちは", spans: [{ language: "ja", start: 0, end: 5 }] }],
            delayMillis: 0,
            failure: null
          }
        ]
      })
    )
  )
)
