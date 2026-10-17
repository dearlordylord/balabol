import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { chmod, mkdtemp, open, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import type { Scope } from "effect"
import { RecognitionFailed } from "./provider.ts"
import { runWhisperProcess } from "./whisper-process.ts"

export const WhisperSettings = Schema.Struct({
  provider: Schema.Literals(["fake", "whisper"]),
  executable: Schema.NonEmptyString,
  modelPath: Schema.NonEmptyString
})
export type WhisperSettings = typeof WhisperSettings.Type
export const whisperModelBytes = 487601967
export const whisperModelSha256 = "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b"
const maximumResultBytes = 1024 * 1024
const privateDirectoryMode = 0o700
const privateFileMode = 0o600
const failed = (message: string) => new RecognitionFailed({ message, reason: "File" })
const io = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({ try: operation, catch: () => failed("Local recognition file operation failed") })
// Ports describe Effect-owned resources; byte/JSON boundaries are parsed by the adapter.
export interface WhisperNative {
  readonly prepare: (settings: WhisperSettings) => Effect.Effect<void, RecognitionFailed>
  readonly transcribe: (
    settings: WhisperSettings,
    wav: Uint8Array
  ) => Effect.Effect<string, RecognitionFailed, Scope.Scope>
}
const verifyModel = (path: string) =>
  Effect.tryPromise({
    try: async (signal) => {
      const metadata = await stat(path)
      if (!metadata.isFile() || metadata.size !== whisperModelBytes) return false
      const hash = createHash("sha256")
      for await (const chunk of createReadStream(path, { signal })) hash.update(chunk)
      return hash.digest("hex") === whisperModelSha256
    },
    catch: () => failed("Pinned local recognition model is unavailable")
  }).pipe(
    Effect.flatMap((valid) =>
      valid ? Effect.void : Effect.fail(failed("Local recognition model does not match the pinned small weights"))
    )
  )
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
export const whisperNative: WhisperNative = {
  prepare: (settings) =>
    Effect.gen(function* () {
      const version = yield* runWhisperProcess(settings.executable, ["--version"])
      if (version.trim() !== "whisper.cpp version: 1.9.5")
        return yield* new RecognitionFailed({
          message: "Local recognition requires whisper.cpp 1.9.5",
          reason: "Process"
        })
      yield* verifyModel(settings.modelPath)
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
      yield* runWhisperProcess(settings.executable, [
        "-m",
        settings.modelPath,
        "-f",
        input,
        "-l",
        "auto",
        "--suppress-nst",
        "-oj",
        "-of",
        output
      ])
      return yield* readResult(`${output}.json`)
    })
}
