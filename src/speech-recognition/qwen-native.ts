import { chmod, mkdtemp, open, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import type { Scope } from "effect"
import { RecognitionFailed } from "./provider.ts"
import { runQwenProcess } from "./qwen-process.ts"

export const QwenSettings = Schema.Struct({
  provider: Schema.Literals(["fake", "qwen3-asr"]),
  executable: Schema.NonEmptyString,
  helperPath: Schema.NonEmptyString,
  modelPath: Schema.NonEmptyString
})
export type QwenSettings = typeof QwenSettings.Type
const maximumResultBytes = 1024 * 1024
const privateDirectoryMode = 0o700
const privateFileMode = 0o600
const failed = (message: string) => new RecognitionFailed({ message, reason: "File" })
const io = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({ try: operation, catch: () => failed("Local recognition file operation failed") })
// Ports describe Effect-owned resources; byte/JSON boundaries are parsed by the adapter.
export interface QwenNative {
  readonly prepare: (settings: QwenSettings) => Effect.Effect<void, RecognitionFailed>
  readonly transcribe: (
    settings: QwenSettings,
    wav: Uint8Array
  ) => Effect.Effect<string, RecognitionFailed, Scope.Scope>
}
const Handshake = Schema.Struct({
  version: Schema.Literal("0.5.9"),
  modelRevision: Schema.Literal("a8379a2e2f9e313c9292cdf1af4055ab56d50d55")
})
const readResult = (path: string) =>
  Effect.gen(function* () {
    const file = yield* Effect.acquireRelease(
      io(() => open(path, "r")),
      (handle) => Effect.promise(() => handle.close())
    )
    const buffer = Buffer.alloc(maximumResultBytes + 1)
    const result = yield* io(() => file.read(buffer, 0, buffer.length, 0))
    if (result.bytesRead > maximumResultBytes) return yield* failed("Local recognition result exceeded its limit")
    return yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, result.bytesRead)),
      catch: () => failed("Invalid UTF-8 recognition result")
    })
  })
export const qwenNative: QwenNative = {
  prepare: (settings) =>
    Effect.gen(function* () {
      const output = yield* runQwenProcess(settings.executable, [
        settings.helperPath,
        "--check",
        "--model",
        settings.modelPath
      ])
      const raw = yield* Effect.try({
        try: (): unknown => JSON.parse(output),
        catch: () => new RecognitionFailed({ message: "Invalid local recognition readiness JSON", reason: "Json" })
      })
      yield* Schema.decodeUnknownEffect(Handshake)(raw).pipe(
        Effect.mapError(
          () =>
            new RecognitionFailed({
              message: "Local recognition requires the pinned Qwen model and MLX Audio 0.5.9",
              reason: "Result"
            })
        )
      )
    }),
  transcribe: (settings, wav) =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        io(() => mkdtemp(join(tmpdir(), "balabol-recognition-"))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true }))
      )
      yield* io(() => chmod(directory, privateDirectoryMode))
      const input = join(directory, "input.wav")
      const output = join(directory, "result")
      yield* io(() => writeFile(input, wav, { mode: privateFileMode }))
      yield* io(() => writeFile(`${output}.json`, "", { mode: privateFileMode }))
      yield* runQwenProcess(settings.executable, [
        settings.helperPath,
        "--model",
        settings.modelPath,
        "--input",
        input,
        "--output",
        `${output}.json`
      ])
      return yield* readResult(`${output}.json`)
    })
}
