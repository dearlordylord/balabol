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

it("rejects removed local providers instead of silently falling back", async () => {
  for (const environment of [
    { BALABOL_RECOGNITION_PROVIDER: "qwen3-asr" },
    { BALABOL_SYNTHESIS_PROVIDER: "apple" },
    { BALABOL_RECOGNITION_PROVIDER: "unknown" },
    { BALABOL_SYNTHESIS_PROVIDER: "unknown" },
    { BALABOL_VOICE_COMPLETION_MILLIS: "300001" }
  ])
    expect(await Effect.runPromise(parseConfig(environment).pipe(Effect.isFailure))).toBe(true)
})

it("selects cloud synthesis independently, validates its credentials and preserves explicit playback budgets", async () => {
  const config = await Effect.runPromise(
    parseConfig({
      BALABOL_SYNTHESIS_PROVIDER: "soniox",
      SONIOX_API_KEY: "fixture-only",
      BALABOL_SONIOX_VOICE: "Adrian"
    })
  )
  expect(config.synthesis).toMatchObject({ provider: "soniox", voice: "Adrian" })
  expect(config.recognition?.provider).toBe("fake")
  expect(config.voiceOutput).toEqual({ completionMillis: 300000 })
  expect(JSON.stringify(config.synthesis)).not.toContain("fixture-only")
  expect(
    (
      await Effect.runPromise(
        parseConfig({
          BALABOL_SYNTHESIS_PROVIDER: "soniox",
          SONIOX_API_KEY: "fixture-only",
          BALABOL_VOICE_COMPLETION_MILLIS: "90000"
        })
      )
    ).voiceOutput
  ).toEqual({ completionMillis: 90000 })
  for (const environment of [
    { BALABOL_SYNTHESIS_PROVIDER: "soniox" },
    { BALABOL_SYNTHESIS_PROVIDER: "soniox", SONIOX_API_KEY: "" },
    { BALABOL_SYNTHESIS_PROVIDER: "soniox", SONIOX_API_KEY: "fixture-only", BALABOL_SONIOX_VOICE: "" }
  ])
    expect(await Effect.runPromise(parseConfig(environment).pipe(Effect.isFailure))).toBe(true)
})
