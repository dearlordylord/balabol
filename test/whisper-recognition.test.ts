import { it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vitest"
import {
  SpeechRecognition,
  RecognitionFailed,
  whisperRecognitionLayer,
  type RecognitionRequest,
  type WhisperNative,
  type WhisperSettings
} from "../src/speech-recognition/index.ts"
const settings: WhisperSettings = { provider: "whisper", executable: "fixture", modelPath: "fixture.bin" }
const request: RecognitionRequest = {
  utteranceId: "11111111-1111-4111-8111-111111111111",
  audio: {
    encoding: "pcm-s16le",
    sampleRateHz: 16000,
    channels: 1,
    sampleFrames: 2,
    bytes: new Uint8Array([1, 2, 3, 4])
  },
  allowedLanguages: ["ru", "fr", "en"]
}
const payload = (language: string | null, text: string) =>
  JSON.stringify({ result: { language }, transcription: [{ text }] })
const fixture = (transcribe: WhisperNative["transcribe"]): WhisperNative => ({ prepare: () => Effect.void, transcribe })
const collect = (provider: SpeechRecognition["Service"], input = request) =>
  Stream.runCollect(provider.recognize(input))
it.effect("encodes bounded PCM as mono 16kHz WAV and preserves mixed text with honest whole-result language", () =>
  Effect.gen(function* () {
    let captured = Buffer.alloc(0)
    const native = fixture((_settings, wav) => {
      captured = Buffer.from(wav)
      return Effect.succeed(payload("fr", " Bonjour Hello Привет "))
    })
    const output = yield* Effect.gen(function* () {
      return yield* collect(yield* SpeechRecognition)
    }).pipe(Effect.provide(whisperRecognitionLayer(settings, native)))
    expect(output).toEqual([
      {
        kind: "Final",
        utteranceId: request.utteranceId,
        text: "Bonjour Hello Привет",
        spans: [],
        detectedLanguage: "fr"
      }
    ])
    expect(captured.toString("ascii", 0, 4)).toBe("RIFF")
    expect(captured.readUInt32LE(4)).toBe(40)
    expect(captured.toString("ascii", 8, 16)).toBe("WAVEfmt ")
    expect(captured.readUInt16LE(20)).toBe(1)
    expect(captured.readUInt16LE(22)).toBe(1)
    expect(captured.readUInt32LE(24)).toBe(16000)
    expect(captured.readUInt32LE(28)).toBe(32000)
    expect(captured.readUInt16LE(32)).toBe(2)
    expect(captured.readUInt16LE(34)).toBe(16)
    expect(captured.toString("ascii", 36, 40)).toBe("data")
    expect(captured.readUInt32LE(40)).toBe(4)
    expect(captured.subarray(44)).toEqual(Buffer.from([1, 2, 3, 4]))
  })
)
it.effect("fails malformed results, unknown languages and worker errors then allows the next utterance", () =>
  Effect.gen(function* () {
    const responses = [
      "not-json",
      "{}",
      payload("de", "Hallo"),
      payload("invalid_language", "Hi"),
      payload("en", "x".repeat(100001)),
      payload("ru", "Привет"),
      payload("fr", "Bonjour"),
      payload("en", "Hello"),
      payload("de", " "),
      "worker"
    ]
    let index = 0
    const native = fixture(() => {
      const value = responses[index++]
      return value === "worker"
        ? Effect.fail(new RecognitionFailed({ message: "worker failed" }))
        : Effect.succeed(value ?? "{}")
    })
    yield* Effect.gen(function* () {
      const provider = yield* SpeechRecognition
      for (let i = 0; i < 5; i++) expect((yield* collect(provider).pipe(Effect.result))._tag).toBe("Failure")
      for (const language of ["ru", "fr", "en", null]) {
        const events = yield* collect(provider)
        expect(events[0]).toMatchObject({ kind: "Final", detectedLanguage: language, spans: [] })
      }
      expect((yield* collect(provider).pipe(Effect.result))._tag).toBe("Failure")
    }).pipe(Effect.provide(whisperRecognitionLayer(settings, native)))
  })
)
it.effect("rejects invalid audio and unsupported configured languages; empty input needs no worker", () =>
  Effect.gen(function* () {
    const native = fixture(() => Effect.die("must not execute"))
    yield* Effect.gen(function* () {
      const provider = yield* SpeechRecognition
      expect(
        (yield* collect(provider, { ...request, audio: { ...request.audio, sampleFrames: 3 } }).pipe(Effect.result))
          ._tag
      ).toBe("Failure")
      expect((yield* collect(provider, { ...request, allowedLanguages: ["de"] }).pipe(Effect.result))._tag).toBe(
        "Failure"
      )
      expect(
        yield* collect(provider, { ...request, audio: { ...request.audio, sampleFrames: 0, bytes: new Uint8Array() } })
      ).toMatchObject([{ text: "", detectedLanguage: null }])
    }).pipe(Effect.provide(whisperRecognitionLayer(settings, native)))
  })
)
it.effect("deadline and cancellation release the serialized worker and suppress late results", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const late = yield* Deferred.make<string>()
    let calls = 0
    let released = false
    const native = fixture(() => {
      calls += 1
      return calls === 1
        ? Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(late)),
            Effect.ensuring(
              Effect.sync(() => {
                released = true
              })
            )
          )
        : Effect.succeed(payload("en", "Recovered"))
    })
    yield* Effect.gen(function* () {
      const provider = yield* SpeechRecognition
      const task = yield* Effect.forkChild(collect(provider).pipe(Effect.flip))
      yield* Deferred.await(entered)
      yield* TestClock.adjust(30001)
      expect(yield* Fiber.join(task)).toMatchObject({ _tag: "RecognitionFailed", reason: "Deadline" })
      expect(released).toBe(true)
      yield* Deferred.succeed(late, payload("en", "Late"))
      expect(yield* collect(provider)).toMatchObject([{ text: "Recovered" }])
    }).pipe(Effect.provide(whisperRecognitionLayer(settings, native)))
  })
)
it.effect("startup failure is typed and never substitutes fake recognition", () =>
  Effect.gen(function* () {
    const native = {
      ...fixture(() => Effect.succeed(payload("en", "Hi"))),
      prepare: () => Effect.fail(new RecognitionFailed({ message: "missing model" }))
    }
    const result = yield* Effect.gen(function* () {
      return yield* SpeechRecognition
    }).pipe(Effect.provide(whisperRecognitionLayer(settings, native)), Effect.result)
    expect(result._tag).toBe("Failure")
  })
)

it.effect("discards only observed standalone non-speech caption segments and retains actual speech", () =>
  Effect.gen(function* () {
    const cases = [
      { segments: [" [BLANK_AUDIO] "], expected: "" },
      { segments: ["[BLANK AUDIO]"], expected: "" },
      { segments: [" (keyboard tapping) "], expected: "" },
      { segments: ["[BLANK_AUDIO] (keyboard tapping)"], expected: "" },
      { segments: ["Bonjour ", "(keyboard tapping)", " Hello Привет"], expected: "Bonjour  Hello Привет" },
      { segments: ["keyboard tapping"], expected: "keyboard tapping" },
      {
        segments: ["Bonjour, je voudrais apprendre le français. Привет. Hello."],
        expected: "Bonjour, je voudrais apprendre le français. Привет. Hello."
      },
      {
        segments: ["I said speaking in foreign language literally."],
        expected: "I said speaking in foreign language literally."
      },
      {
        segments: ["The label is (speaking in foreign language)."],
        expected: "The label is (speaking in foreign language)."
      },
      { segments: ["Please say [BLANK_AUDIO] literally."], expected: "Please say [BLANK_AUDIO] literally." },
      {
        segments: ["This is (keyboard tapping) as a quoted label."],
        expected: "This is (keyboard tapping) as a quoted label."
      },
      {
        segments: ["(this is a genuine parenthetical sentence)"],
        expected: "(this is a genuine parenthetical sentence)"
      }
    ]
    for (const item of cases) {
      const native = fixture(() =>
        Effect.succeed(
          JSON.stringify({ result: { language: "en" }, transcription: item.segments.map((text) => ({ text })) })
        )
      )
      const events = yield* Effect.gen(function* () {
        return yield* collect(yield* SpeechRecognition)
      }).pipe(Effect.provide(whisperRecognitionLayer(settings, native)))
      expect(events).toEqual([
        {
          kind: "Final",
          utteranceId: request.utteranceId,
          text: item.expected,
          spans: [],
          detectedLanguage: item.expected.length === 0 ? null : "en"
        }
      ])
    }
  })
)

it.effect("preserves typed failure stage without inspecting or exposing provider messages", () =>
  Effect.gen(function* () {
    const cases: { native: WhisperNative; input: RecognitionRequest; reason: string }[] = [
      { native: fixture(() => Effect.succeed("{")), input: request, reason: "Json" },
      { native: fixture(() => Effect.succeed('{"result":{},"transcription":[]}')), input: request, reason: "Result" },
      { native: fixture(() => Effect.succeed(payload("de", "Guten Tag"))), input: request, reason: "DetectedLanguage" },
      {
        native: fixture(() => Effect.succeed(payload("en", "unused"))),
        input: { ...request, allowedLanguages: ["xx"] },
        reason: "Request"
      },
      {
        native: fixture(() =>
          Effect.succeed(
            JSON.stringify({ result: { language: "en" }, transcription: [{ text: "x".repeat(100000) }, { text: "y" }] })
          )
        ),
        input: request,
        reason: "Final"
      },
      {
        native: fixture(() =>
          Effect.fail(new RecognitionFailed({ message: "private process diagnostics", reason: "Process" }))
        ),
        input: request,
        reason: "Process"
      },
      {
        native: fixture(() => Effect.fail(new RecognitionFailed({ message: "private file path", reason: "File" }))),
        input: request,
        reason: "File"
      },
      {
        native: fixture(() => Effect.fail(new RecognitionFailed({ message: "legacy provider failure" }))),
        input: request,
        reason: "Other"
      }
    ]
    for (const item of cases) {
      const error = yield* Effect.gen(function* () {
        return yield* collect(yield* SpeechRecognition, item.input).pipe(Effect.flip)
      }).pipe(Effect.provide(whisperRecognitionLayer(settings, item.native)))
      expect(error._tag).toBe("RecognitionFailed")
      expect(error.reason ?? "Other").toBe(item.reason)
    }
  })
)

it.effect("rejects foreign-speech captions instead of saving fabricated or incomplete speech", () =>
  Effect.gen(function* () {
    for (const text of [
      "(speaking in foreign language)",
      "(speaking in foreign language) Затем продолжение.",
      "[speaking in a foreign language]"
    ]) {
      const error = yield* Effect.gen(function* () {
        return yield* collect(yield* SpeechRecognition).pipe(Effect.flip)
      }).pipe(
        Effect.provide(
          whisperRecognitionLayer(
            settings,
            fixture(() => Effect.succeed(payload("ru", text)))
          )
        )
      )
      expect(error._tag).toBe("RecognitionFailed")
      expect(error.reason).toBe("UntranscribedSpeech")
    }
  })
)
