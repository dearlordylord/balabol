import { Effect, Layer, Schema, Semaphore, Stream } from "effect"
import { LanguageTags, isScalarBoundary } from "../language/index.ts"
import { SpeechSynthesis, SpeechSynthesisFailed, SynthesisEvent, SynthesisRequest } from "./provider.ts"
import { AppleReceipt, AppleSynthesisSettings, AppleVoice, appleNative } from "./apple-native.ts"
import type { AppleNative } from "./apple-native.ts"
const maximumVoices = 1000
const maximumPhraseChars = 800
const maximumPlanBytes = 1048576
const sampleRateHz = 24000
const resamplingToleranceFrames = 2
const preparationMillis = 10000
const deadlineMillis = 60000
const maximumFrames = 1440000
const chunkFrames = 1200
const bytesPerFrame = 2
const failed = (message: string) =>
  new SpeechSynthesisFailed({ message, diagnostic: { category: "Synthesis", reason: "Protocol", provider: "apple" } })
const json = (text: string) =>
  Effect.try({ try: (): unknown => JSON.parse(text), catch: () => failed("Invalid Apple synthesis JSON") })
const parseVoices = (text: string) =>
  json(text).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(AppleVoice).check(Schema.isMaxLength(maximumVoices)))),
    Effect.mapError(() => failed("Invalid installed Apple voices"))
  )
const Plan = Schema.Struct({
  runs: Schema.Array(
    Schema.Struct({
      text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximumPhraseChars)),
      voiceId: AppleVoice.fields.id,
      actualLocale: AppleVoice.fields.actualLocale
    })
  ).check(Schema.isMinLength(1), Schema.isMaxLength(maximumPhraseChars))
})
const parsePlan = (serialized: string, text: string, voices: readonly AppleVoice[]) =>
  Effect.gen(function* () {
    if (Buffer.byteLength(serialized) > maximumPlanBytes)
      return yield* failed("Apple synthesis plan exceeded its limit")
    const plan = yield* json(serialized).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Plan)),
      Effect.mapError(() => failed("Invalid Apple synthesis plan"))
    )
    if (plan.runs.map((run) => run.text).join("") !== text)
      return yield* failed("Apple synthesis plan changed phrase text")
    if (
      !plan.runs.every((run) =>
        voices.some((voice) => voice.id === run.voiceId && voice.actualLocale === run.actualLocale)
      )
    )
      return yield* failed("Apple synthesis plan selected an unconfigured voice")
    let offset = 0
    for (const run of plan.runs) {
      offset += run.text.length
      if (!isScalarBoundary(text, offset)) return yield* failed("Apple synthesis plan split a Unicode scalar")
    }
    return plan.runs
  })
const preferredLocales: Readonly<Record<string, string>> = { en: "en-US", ru: "ru-RU", fr: "fr-FR", ja: "ja-JP" }
const chooseVoice = (voices: readonly AppleVoice[], language: string) =>
  voices
    .filter((voice) => voice.actualLocale.split("-")[0] === language && voice.id.startsWith("com.apple.voice."))
    .toSorted(
      (a, b) =>
        Number(b.actualLocale === preferredLocales[language]) - Number(a.actualLocale === preferredLocales[language]) ||
        a.id.localeCompare(b.id)
    )[0]
const render = (native: AppleNative, config: AppleSynthesisSettings, text: string, voice: AppleVoice) =>
  Effect.gen(function* () {
    const result = yield* native.render(config, text, voice)
    const receipt = yield* json(result.receipt).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(AppleReceipt)),
      Effect.mapError(() => failed("Invalid Apple synthesis completion"))
    )
    if (receipt.voiceId !== voice.id || receipt.actualLocale !== voice.actualLocale)
      return yield* failed("Apple synthesis voice changed")
    const frames = result.pcm.byteLength / bytesPerFrame
    if (!Number.isInteger(frames) || frames <= 0 || frames > maximumFrames)
      return yield* failed("Invalid Apple synthesis PCM duration")
    const expectedFrames = (receipt.frames * sampleRateHz) / receipt.sampleRate
    if (Math.abs(frames - expectedFrames) > resamplingToleranceFrames)
      return yield* failed("Incomplete Apple synthesis conversion")
    return result.pcm
  })
const renderPhrase = (
  native: AppleNative,
  config: AppleSynthesisSettings,
  request: SynthesisRequest,
  voice: AppleVoice,
  allowed: readonly AppleVoice[]
) =>
  Effect.gen(function* () {
    const runs = yield* native.plan(config, request.text, voice, allowed).pipe(
      Effect.flatMap((serialized) => parsePlan(serialized, request.text, allowed)),
      Effect.mapError((error) =>
        error.reason === undefined || error.reason === "NativeProcessFailed"
          ? new SpeechSynthesisFailed({ message: "Apple pronunciation planning failed", reason: "SynthesisPlanFailed" })
          : error
      )
    )
    const parts: Uint8Array[] = []
    let total = 0
    for (const run of runs) {
      const pcm = yield* render(native, config, run.text, { id: run.voiceId, actualLocale: run.actualLocale })
      total += pcm.byteLength
      if (total > maximumFrames * bytesPerFrame) return yield* failed("Apple synthesis phrase audio exceeded its limit")
      parts.push(pcm)
    }
    const combined = new Uint8Array(total)
    let offset = 0
    for (const part of parts) {
      combined.set(part, offset)
      offset += part.byteLength
    }
    return combined
  })
const events = (pcm: Uint8Array, request: SynthesisRequest) => {
  const frames = pcm.byteLength / bytesPerFrame
  const chunks = Math.ceil(frames / chunkFrames)
  return Stream.range(0, chunks).pipe(
    Stream.mapEffect((sequence) =>
      Schema.decodeUnknownEffect(SynthesisEvent)(
        sequence === chunks
          ? { kind: "Completed", responseId: request.responseId, phraseId: request.phraseId, sequence }
          : {
              kind: "Chunk",
              responseId: request.responseId,
              phraseId: request.phraseId,
              sequence,
              audio: {
                encoding: "pcm-s16le",
                sampleRateHz,
                channels: 1,
                sampleFrames: Math.min(chunkFrames, frames - sequence * chunkFrames),
                bytes: pcm.slice(sequence * chunkFrames * bytesPerFrame, (sequence + 1) * chunkFrames * bytesPerFrame)
              }
            }
      ).pipe(Effect.mapError(() => failed("Invalid Apple synthesis event")))
    )
  )
}
// Complete-phrase native generation precedes chunk delivery; this does not accept incremental text.
// The scoped native worker drains EOS and closes its CAF before conversion or any Chunk is emitted.
export const appleSynthesisLayer = (
  settings: AppleSynthesisSettings,
  languages: readonly string[] = ["ru", "fr", "en"],
  native: AppleNative = appleNative
) =>
  Layer.effect(
    SpeechSynthesis,
    Effect.gen(function* () {
      const config = yield* Schema.decodeUnknownEffect(AppleSynthesisSettings)(settings).pipe(
        Effect.mapError(() => failed("Invalid Apple synthesis configuration"))
      )
      const supported = yield* Schema.decodeUnknownEffect(LanguageTags)(languages).pipe(
        Effect.mapError(() => failed("Invalid Apple synthesis languages"))
      )
      const voices = yield* native.voices(config).pipe(
        Effect.flatMap(parseVoices),
        Effect.timeout(preparationMillis),
        Effect.mapError(() => failed("Apple speech helper unavailable; build:speech and installed voices are required"))
      )
      const chosen: AppleVoice[] = []
      for (const language of supported) {
        const installed = chooseVoice(voices, language)
        if (!installed) return yield* failed(`Missing installed Apple voice for ${language}`)
        chosen.push(installed)
      }
      const serial = yield* Semaphore.make(1)
      return SpeechSynthesis.of({
        capabilities: {
          input: "supplied-text",
          output: "streaming-pcm",
          languages: supported,
          encoding: "pcm-s16le",
          sampleRateHz,
          channels: 1,
          maxPhraseChars: maximumPhraseChars,
          maxAudioFrames: maximumFrames
        },
        synthesize: (raw) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const request = yield* Schema.decodeUnknownEffect(SynthesisRequest)(raw).pipe(
                Effect.mapError(() => failed("Invalid synthesis phrase request"))
              )
              const voice = chooseVoice(voices, request.language)
              if (!supported.includes(request.language) || !voice)
                return yield* failed("Unsupported Apple synthesis language")
              const pcm = yield* renderPhrase(native, config, request, voice, chosen).pipe(
                Effect.scoped,
                serial.withPermits(1),
                Effect.timeout(deadlineMillis),
                Effect.mapError((error) =>
                  error instanceof SpeechSynthesisFailed
                    ? error
                    : new SpeechSynthesisFailed({
                        message: "Apple synthesis exceeded its deadline",
                        reason: "SynthesisDeadline"
                      })
                )
              )
              return events(pcm, request)
            })
          )
      })
    })
  )
