import { it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Redacted, Stream } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vitest"
import { SpeechRecognition, sonioxRecognitionLayer, type RecognitionRequest } from "../src/speech-recognition/index.ts"
import { SonioxSocket } from "./soniox-fixture.ts"
const settings = { provider: "soniox" as const, apiKey: Redacted.make("fixture-only-not-a-credential") }
const request: RecognitionRequest = {
  utteranceId: "11111111-1111-4111-8111-111111111111",
  audio: { encoding: "pcm-s16le", sampleRateHz: 16000, channels: 1, sampleFrames: 2, bytes: new Uint8Array(4) },
  allowedLanguages: ["ru", "fr", "en"]
}
const token = (text: string, language = "fr", is_final = true) => ({ text, language, is_final })
const collect = (socket: SonioxSocket, input = request) =>
  Effect.gen(function* () {
    const provider = yield* SpeechRecognition
    return yield* Stream.runCollect(provider.recognize(input))
  }).pipe(Effect.provide(sonioxRecognitionLayer(settings, socket.factory)))
it.effect("preserves mixed-language text and UTF-16 spans while replacing provisional text", () =>
  Effect.gen(function* () {
    const socket = new SonioxSocket([
      { tokens: [token("Bon", "fr", false)] },
      { tokens: [token("Bonjour "), token("wrong", "en", false)] },
      { tokens: [token("😀привет", "ru"), token("<end>")] }
    ])
    const events = yield* collect(socket)
    expect(events.map((event) => event.text)).toEqual(["Bon", "Bonjour wrong", "Bonjour 😀привет", "Bonjour 😀привет"])
    expect(events.at(-1)).toEqual({
      kind: "Final",
      utteranceId: request.utteranceId,
      text: "Bonjour 😀привет",
      detectedLanguage: null,
      spans: [
        { start: 0, end: 8, language: "fr" },
        { start: 8, end: 16, language: "ru" }
      ]
    })
    expect(JSON.parse(String(socket.sent[0]))).toMatchObject({
      model: "stt-rt-v5",
      language_hints: request.allowedLanguages,
      language_hints_strict: true,
      enable_endpoint_detection: false,
      enable_language_identification: true
    })
    expect(socket.sent[1]).toEqual(request.audio.bytes)
    expect(socket.sent[2]).toBe("")
    expect(socket.closed).toBe(true)
  })
)
it.effect("allows an honest empty final and coalesces adjacent same-language tokens", () =>
  Effect.gen(function* () {
    expect((yield* collect(new SonioxSocket())).at(-1)).toMatchObject({
      kind: "Final",
      text: "",
      spans: [],
      detectedLanguage: null
    })
    const result = yield* collect(new SonioxSocket([{ tokens: [token("Bon"), token("jour"), token("<fin>")] }]))
    expect(result.at(-1)).toMatchObject({
      text: "Bonjour",
      detectedLanguage: "fr",
      spans: [{ start: 0, end: 7, language: "fr" }]
    })
  })
)
for (const [name, packets, terminal] of [
  [
    "provider rejection",
    [{ error_code: 401, error_type: "secret must never leak", error_message: "secret must never leak" }],
    "finished"
  ],
  ["malformed JSON", ["{"], "finished"],
  ["invalid schema", [{ tokens: [{ text: 12 }] }], "finished"],
  ["unconfigured language", [{ tokens: [token("hola", "es")] }], "finished"],
  ["uncommitted terminal", [{ tokens: [token("unfinished", "en", false)], finished: true }], "finished"],
  ["early close", [], "close"],
  ["network error", [], "error"],
  ["oversized response", ["x".repeat(1024 * 1024 + 1)], "finished"]
] as const)
  it.effect(`reports ${name} without an accepted final or raw provider text`, () =>
    Effect.gen(function* () {
      const socket = new SonioxSocket(packets, terminal)
      const result = yield* collect(socket).pipe(Effect.result)
      expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "RecognitionFailed" } })
      expect(JSON.stringify(result)).not.toContain("secret must never leak")
      expect(socket.closed).toBe(true)
    })
  )
it.effect("cancellation closes its exact socket and fences late packets", () =>
  Effect.gen(function* () {
    const socket = new SonioxSocket([], "wait")
    const fiber = yield* collect(socket).pipe(Effect.forkChild)
    yield* Deferred.await(socket.opened)
    yield* Fiber.interrupt(fiber)
    expect(socket.closed).toBe(true)
    socket.message({ tokens: [token("late")], finished: true })
  })
)
it.effect("rejects malformed input before opening a network connection", () =>
  Effect.gen(function* () {
    const socket = new SonioxSocket()
    const result = yield* collect(socket, { ...request, audio: { ...request.audio, sampleFrames: 99 } }).pipe(
      Effect.result
    )
    expect(result).toMatchObject({ _tag: "Failure" })
    expect(socket.sent).toEqual([])
  })
)

it.effect("bounds a stalled connection with an Effect-clock deadline", () =>
  Effect.gen(function* () {
    const socket = new SonioxSocket([], "wait")
    const fiber = yield* collect(socket).pipe(Effect.result, Effect.forkChild)
    yield* Deferred.await(socket.opened)
    yield* TestClock.adjust(30001)
    expect(yield* Fiber.join(fiber)).toMatchObject({
      _tag: "Failure",
      failure: { message: "Soniox recognition deadline exceeded" }
    })
    expect(socket.closed).toBe(true)
  })
)

it.effect("retires a connecting socket before a captured late-open callback can upload audio", () =>
  Effect.gen(function* () {
    const socket = new SonioxSocket([], "connecting")
    const fiber = yield* collect(socket).pipe(Effect.forkChild)
    yield* Deferred.await(socket.created)
    const lateOpen = socket.onopen
    yield* Fiber.interrupt(fiber)
    lateOpen?.call(socket, new Event("open"))
    expect(socket.closed).toBe(true)
    expect(socket.sent).toEqual([])
    expect(socket.onmessage).toBeNull()
  })
)

it.effect("keeps Soniox credentials redacted at the configuration boundary and rejects missing keys", () =>
  Effect.gen(function* () {
    const { parseConfig } = yield* Effect.promise(() => import("../src/bootstrap/index.ts"))
    const config = yield* parseConfig({ BALABOL_RECOGNITION_PROVIDER: "soniox", SONIOX_API_KEY: "fixture-private-key" })
    expect(config.recognition?.provider).toBe("soniox")
    expect(config.activity?.provider).toBe("silero")
    expect(JSON.stringify(config)).not.toContain("fixture-private-key")
    expect(yield* parseConfig({ BALABOL_RECOGNITION_PROVIDER: "soniox" }).pipe(Effect.result)).toMatchObject({
      _tag: "Failure"
    })
  })
)
it.effect("reports actionable billing failures without provider text", () =>
  Effect.gen(function* () {
    const result = yield* collect(new SonioxSocket([{ error_code: 402 }])).pipe(Effect.result)
    expect(result).toMatchObject({ _tag: "Failure", failure: { message: expect.stringContaining("check balance") } })
  })
)
