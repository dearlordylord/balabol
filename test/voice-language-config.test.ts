import { Effect, Layer } from "effect"
import { expect, it } from "vitest"
import { parseConfig, serverLayer } from "../src/bootstrap/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"

it("defaults to three configured languages and supports an explicit canonical Japanese extension", async () => {
  expect((await Effect.runPromise(parseConfig({}))).voiceLanguages).toEqual(["ru", "fr", "en"])
  expect((await Effect.runPromise(parseConfig({ BALABOL_VOICE_LANGUAGES: "RU, fr, en, JA" }))).voiceLanguages).toEqual([
    "ru",
    "fr",
    "en",
    "ja"
  ])
})

it("rejects empty, malformed and canonically duplicate configured language lists", async () => {
  for (const value of ["", "en_US", "en,EN", "fr,"]) {
    expect(await Effect.runPromise(parseConfig({ BALABOL_VOICE_LANGUAGES: value }).pipe(Effect.isFailure))).toBe(true)
  }
})

it("composes the Japanese fake-provider extension and rejects an uninstalled valid language", async () => {
  const fixture = await temporaryDatabase()
  try {
    for (const languages of ["ru,fr,en,ja", "de"]) {
      const config = await Effect.runPromise(
        parseConfig({
          BALABOL_PORT: "0",
          BALABOL_DATABASE: fixture.path,
          BALABOL_VOICE_LANGUAGES: languages,
          BALABOL_LIVEKIT_URL: "ws://127.0.0.1:1",
          BALABOL_LIVEKIT_API_KEY: "fixture-key",
          BALABOL_LIVEKIT_API_SECRET: "fixture-only-language-config-not-a-real-credential"
        })
      )
      const startup = Effect.scoped(Layer.build(serverLayer(config)))
      if (languages === "de") {
        expect(await Effect.runPromise(startup.pipe(Effect.flip))).toMatchObject({
          _tag: "VoiceFailed",
          code: "InvalidLanguageConfiguration"
        })
      } else {
        await Effect.runPromise(startup)
      }
    }
  } finally {
    await fixture.close()
  }
})

it("selects validated local synthesis and independent bounded playback policy without acquiring native resources", async () => {
  const config = await Effect.runPromise(parseConfig({ BALABOL_SYNTHESIS_PROVIDER: "apple" }))
  expect(config.synthesis).toMatchObject({ provider: "apple", ffmpegExecutable: "/opt/homebrew/bin/ffmpeg" })
  expect(config.voiceOutput).toEqual({ completionMillis: 300000 })
  expect((await Effect.runPromise(parseConfig({}))).voiceOutput).toEqual({ completionMillis: 30000 })
  expect(
    (
      await Effect.runPromise(
        parseConfig({ BALABOL_SYNTHESIS_PROVIDER: "apple", BALABOL_VOICE_COMPLETION_MILLIS: "90000" })
      )
    ).voiceOutput
  ).toEqual({ completionMillis: 90000 })
  for (const environment of [
    { BALABOL_SYNTHESIS_PROVIDER: "unknown" },
    { BALABOL_VOICE_COMPLETION_MILLIS: "300001" },
    { BALABOL_APPLE_SPEECH_EXECUTABLE: "" }
  ])
    expect(await Effect.runPromise(parseConfig(environment).pipe(Effect.isFailure))).toBe(true)
})

it("selects validated Qwen resources and speech classification without acquiring native models", async () => {
  const config = await Effect.runPromise(
    parseConfig({
      BALABOL_RECOGNITION_PROVIDER: "qwen3-asr",
      BALABOL_QWEN_PYTHON_PATH: "/fixture/python",
      BALABOL_QWEN_HELPER_PATH: "/fixture/qwen.py",
      BALABOL_QWEN_MODEL: "/fixture/model"
    })
  )
  expect(config.recognition).toEqual({
    provider: "qwen3-asr",
    executable: "/fixture/python",
    helperPath: "/fixture/qwen.py",
    modelPath: "/fixture/model"
  })
  expect(config.activity?.provider).toBe("silero")
  expect((await Effect.runPromise(parseConfig({}))).recognition?.provider).toBe("fake")
  for (const environment of [
    { BALABOL_RECOGNITION_PROVIDER: "whisper" },
    { BALABOL_QWEN_PYTHON_PATH: "" },
    { BALABOL_QWEN_HELPER_PATH: "" },
    { BALABOL_QWEN_MODEL: "" }
  ])
    expect(await Effect.runPromise(parseConfig(environment).pipe(Effect.isFailure))).toBe(true)
})
