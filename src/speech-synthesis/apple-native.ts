import { withAuditSpan } from "../operation-audit/index.ts"
import { chmod, mkdtemp, open, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import type { Scope } from "effect"
import { SpeechSynthesisFailed } from "./provider.ts"
import { runAppleProcess } from "./apple-process.ts"

export const AppleSynthesisSettings = Schema.Struct({
  provider: Schema.Literals(["fake", "apple"]),
  helperExecutable: Schema.NonEmptyString,
  ffmpegExecutable: Schema.NonEmptyString
})
export type AppleSynthesisSettings = typeof AppleSynthesisSettings.Type
export const AppleVoice = Schema.Struct({ id: Schema.NonEmptyString, actualLocale: Schema.NonEmptyString })
export type AppleVoice = typeof AppleVoice.Type
const maximumDurationSeconds = 60
const privateDirectoryMode = 0o700
const privateFileMode = 0o600
export const AppleReceipt = Schema.Struct({
  voiceId: Schema.NonEmptyString,
  actualLocale: Schema.NonEmptyString,
  frames: Schema.Int.check(Schema.isGreaterThan(0)),
  sampleRate: Schema.Number.check(Schema.isGreaterThan(0)),
  completed: Schema.Literal(true)
}).check(Schema.makeFilter((receipt) => receipt.frames / receipt.sampleRate <= maximumDurationSeconds))
const maximumBytes = 2880000
const failed = () =>
  new SpeechSynthesisFailed({
    message: "Apple synthesis file operation failed",
    diagnostic: { category: "Synthesis", reason: "File", provider: "apple" }
  })
const io = <A>(operation: () => Promise<A>) => Effect.tryPromise({ try: operation, catch: failed })
// Resource port; serialized native JSON and PCM are parsed in the provider.
export interface AppleNative {
  readonly voices: (settings: AppleSynthesisSettings) => Effect.Effect<string, SpeechSynthesisFailed>
  readonly plan: (
    settings: AppleSynthesisSettings,
    text: string,
    voice: AppleVoice,
    allowedVoices: readonly AppleVoice[]
  ) => Effect.Effect<string, SpeechSynthesisFailed>
  readonly render: (
    settings: AppleSynthesisSettings,
    text: string,
    voice: AppleVoice
  ) => Effect.Effect<{ readonly receipt: string; readonly pcm: Uint8Array }, SpeechSynthesisFailed, Scope.Scope>
}
const readPcm = (path: string) =>
  Effect.gen(function* () {
    const file = yield* Effect.acquireRelease(
      io(() => open(path, "r")),
      (handle) => Effect.promise(() => handle.close())
    )
    const buffer = Buffer.alloc(maximumBytes + 1)
    const result = yield* io(() => file.read(buffer, 0, buffer.length, 0))
    if (result.bytesRead > maximumBytes) return yield* failed()
    return new Uint8Array(buffer.subarray(0, result.bytesRead))
  })
export const appleNative: AppleNative = {
  voices: (settings) => runAppleProcess(settings.helperExecutable, ["--voices"]),
  plan: (settings, text, voice, allowedVoices) =>
    runAppleProcess(
      settings.helperExecutable,
      ["--plan"],
      JSON.stringify({ text, voiceId: voice.id, allowedVoices })
    ).pipe(
      Effect.mapError((error) =>
        error.reason === undefined || error.reason === "NativeProcessFailed"
          ? new SpeechSynthesisFailed({
              message: "Apple pronunciation planning failed",
              reason: "SynthesisPlanFailed",
              diagnostic: error.diagnostic ?? {
                category: "Synthesis",
                reason: "SynthesisPlanFailed",
                provider: "apple"
              }
            })
          : error
      ),
      withAuditSpan("speech.plan")
    ),
  render: (settings, text, voice) =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        io(() => mkdtemp(join(tmpdir(), "balabol-synthesis-"))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true }))
      )
      yield* io(() => chmod(directory, privateDirectoryMode))
      const caf = join(directory, "speech.caf")
      const pcm = join(directory, "speech.pcm")
      yield* io(() => writeFile(caf, "", { mode: privateFileMode }))
      yield* io(() => writeFile(pcm, "", { mode: privateFileMode }))
      const receipt = yield* runAppleProcess(
        settings.helperExecutable,
        [],
        JSON.stringify({ text, voiceId: voice.id, outputPath: caf })
      ).pipe(
        Effect.mapError((error) =>
          error.reason === undefined || error.reason === "NativeProcessFailed"
            ? new SpeechSynthesisFailed({
                message: "Apple speech rendering failed",
                reason: "SynthesisRenderFailed",
                diagnostic: error.diagnostic ?? {
                  category: "Synthesis",
                  reason: "SynthesisRenderFailed",
                  provider: "apple"
                }
              })
            : error
        ),
        withAuditSpan("speech.render")
      )
      yield* runAppleProcess(settings.ffmpegExecutable, [
        "-nostdin",
        "-y",
        "-v",
        "error",
        "-i",
        caf,
        "-ac",
        "1",
        "-ar",
        "24000",
        "-f",
        "s16le",
        pcm
      ]).pipe(
        Effect.mapError(
          (error) =>
            new SpeechSynthesisFailed({
              message: "Apple audio conversion failed",
              reason: "AudioConversionFailed",
              diagnostic: error.diagnostic ?? {
                category: "Synthesis",
                reason: "AudioConversionFailed",
                provider: "apple"
              }
            })
        ),
        withAuditSpan("speech.convert")
      )
      return { receipt, pcm: yield* readPcm(pcm) }
    })
}
