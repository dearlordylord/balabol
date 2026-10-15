import { it } from "@effect/vitest"
import { Effect, Fiber, Stream } from "effect"
import { expect } from "vitest"
import { appleSynthesisLayer, SpeechSynthesis, SpeechSynthesisFailed } from "../src/speech-synthesis/index.ts"
import type { AppleNative } from "../src/speech-synthesis/apple-native.ts"
const settings = {
  provider: "apple",
  helperExecutable: "/fixture/helper",
  ffmpegExecutable: "/fixture/ffmpeg"
} satisfies Parameters<typeof appleSynthesisLayer>[0]
const voice = { id: "com.apple.voice.compact.en-US.Samantha", actualLocale: "en-US" }
const request = {
  responseId: "00000000-0000-4000-8000-000000000001",
  phraseId: "00000000-0000-4000-8000-000000000002",
  language: "en",
  text: "Hello."
}
const receipt = (frames: number) =>
  JSON.stringify({ voiceId: voice.id, actualLocale: voice.actualLocale, frames, sampleRate: 24000, completed: true })
const fixture = (pcm: Uint8Array, completion = receipt(pcm.byteLength / 2)): AppleNative => ({
  voices: () => Effect.succeed(JSON.stringify([voice])),
  render: () => Effect.succeed({ pcm, receipt: completion })
})
const collect = (native: AppleNative) =>
  Effect.gen(function* () {
    const provider = yield* SpeechSynthesis
    return yield* Stream.runCollect(provider.synthesize(request))
  }).pipe(Effect.provide(appleSynthesisLayer(settings, ["en"], native)))
it.effect("emits every native PCM frame including the tail and exactly one completion", () =>
  Effect.gen(function* () {
    const pcm = new Uint8Array(4802).map((_, index) => index % 251)
    const result = yield* collect(fixture(pcm))
    expect(result.map((event) => event.kind)).toEqual(["Chunk", "Chunk", "Chunk", "Completed"])
    expect(result.map((event) => event.sequence)).toEqual([0, 1, 2, 3])
    const chunks = result.flatMap((event) => (event.kind === "Chunk" ? [...event.audio.bytes] : []))
    expect(new Uint8Array(chunks)).toEqual(pcm)
  })
)
it.effect("accepts the real provider 60-second ceiling without changing chunk bounds", () =>
  Effect.gen(function* () {
    const result = yield* collect(fixture(new Uint8Array(2880000)))
    expect(result).toHaveLength(1201)
    expect(result.at(-1)).toMatchObject({ kind: "Completed", sequence: 1200 })
  })
)
it.effect("rejects malformed completion, locale changes, invalid PCM and truncation without Completed", () =>
  Effect.gen(function* () {
    for (const native of [
      fixture(new Uint8Array(2), "{"),
      fixture(new Uint8Array(2), receipt(1).replace("en-US", "fr-FR")),
      fixture(new Uint8Array(3)),
      fixture(new Uint8Array(2880002)),
      fixture(new Uint8Array(2), receipt(20)),
      fixture(new Uint8Array(0)),
      fixture(new Uint8Array(2), receipt(1440001))
    ]) {
      expect((yield* collect(native).pipe(Effect.result))._tag).toBe("Failure")
    }
  })
)
it.effect("fails explicitly for missing installed voices and malformed catalogs", () =>
  Effect.gen(function* () {
    for (const catalog of ["[]", "{}", "not-json"]) {
      const native = { ...fixture(new Uint8Array(2)), voices: () => Effect.succeed(catalog) }
      expect((yield* collect(native).pipe(Effect.result))._tag).toBe("Failure")
    }
  })
)
it.effect("cancels owned native work and allows the next phrase to recover", () =>
  Effect.gen(function* () {
    let released = false
    let first = true
    const native: AppleNative = {
      ...fixture(new Uint8Array(2)),
      render: () => {
        if (!first) return Effect.succeed({ pcm: new Uint8Array(2), receipt: receipt(1) })
        first = false
        return Effect.never.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              released = true
            })
          )
        )
      }
    }
    yield* Effect.gen(function* () {
      const provider = yield* SpeechSynthesis
      const fiber = yield* Effect.forkChild(Stream.runCollect(provider.synthesize(request)))
      yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)
      expect(released).toBe(true)
      expect((yield* Stream.runCollect(provider.synthesize(request))).at(-1)?.kind).toBe("Completed")
    }).pipe(Effect.provide(appleSynthesisLayer(settings, ["en"], native)))
  })
)
it.effect("keeps provider failures typed and request capability checks explicit", () =>
  Effect.gen(function* () {
    const native: AppleNative = {
      ...fixture(new Uint8Array(2)),
      render: () => Effect.fail(new SpeechSynthesisFailed({ message: "fixture" }))
    }
    expect((yield* collect(native).pipe(Effect.result))._tag).toBe("Failure")
    yield* Effect.gen(function* () {
      const provider = yield* SpeechSynthesis
      expect(
        (yield* Stream.runCollect(provider.synthesize({ ...request, language: "fr" })).pipe(Effect.result))._tag
      ).toBe("Failure")
      expect((yield* Stream.runCollect(provider.synthesize({ ...request, text: "" })).pipe(Effect.result))._tag).toBe(
        "Failure"
      )
    }).pipe(Effect.provide(appleSynthesisLayer(settings, ["en"], fixture(new Uint8Array(2)))))
  })
)
it.effect("stream interruption fences remaining chunks and completion, then a new phrase succeeds", () =>
  Effect.gen(function* () {
    let observed = 0
    yield* Effect.gen(function* () {
      const provider = yield* SpeechSynthesis
      const task = yield* Effect.forkChild(
        provider.synthesize(request).pipe(
          Stream.tap(() =>
            Effect.sync(() => {
              observed += 1
            })
          ),
          Stream.tap(() => Effect.never),
          Stream.runDrain
        )
      )
      yield* Effect.yieldNow
      yield* Fiber.interrupt(task)
      expect(observed).toBe(1)
      yield* Effect.yieldNow
      expect(observed).toBe(1)
      const next = yield* Stream.runCollect(provider.synthesize(request))
      expect(next.at(-1)?.kind).toBe("Completed")
    }).pipe(Effect.provide(appleSynthesisLayer(settings, ["en"], fixture(new Uint8Array(4802)))))
  })
)
it.effect(
  "selects truthful preferred locales from the installed catalog and supports configured future languages",
  () =>
    Effect.gen(function* () {
      const selected: string[] = []
      const catalog = [
        { id: "com.apple.voice.compact.en-GB.Daniel", actualLocale: "en-GB" },
        voice,
        { id: "com.apple.voice.super-compact.ja-JP.Kyoko", actualLocale: "ja-JP" }
      ]
      const native: AppleNative = {
        voices: () => Effect.succeed(JSON.stringify(catalog)),
        render: (_, __, installed) => {
          selected.push(installed.actualLocale)
          return Effect.succeed({
            pcm: new Uint8Array(2),
            receipt: JSON.stringify({
              voiceId: installed.id,
              actualLocale: installed.actualLocale,
              frames: 1,
              sampleRate: 24000,
              completed: true
            })
          })
        }
      }
      yield* Effect.gen(function* () {
        const provider = yield* SpeechSynthesis
        for (const language of ["en", "ja"]) yield* Stream.runDrain(provider.synthesize({ ...request, language }))
      }).pipe(Effect.provide(appleSynthesisLayer(settings, ["en", "ja"], native)))
      expect(selected).toEqual(["en-US", "ja-JP"])
    })
)
it.effect("rejects invalid startup settings and language configuration", () =>
  Effect.gen(function* () {
    for (const [config, languages] of [
      [{ ...settings, helperExecutable: "" }, ["en"]],
      [settings, []]
    ] satisfies [typeof settings, string[]][]) {
      expect(
        (yield* Effect.gen(function* () {
          return yield* SpeechSynthesis
        }).pipe(Effect.provide(appleSynthesisLayer(config, languages, fixture(new Uint8Array(2)))), Effect.result))._tag
      ).toBe("Failure")
    }
  })
)
