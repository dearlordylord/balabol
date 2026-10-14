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
