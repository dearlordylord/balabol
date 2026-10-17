import { spawn } from "node:child_process"
import { Effect, Option, Schema } from "effect"
import { FailureReason } from "../delivery-failure/index.ts"
import { SpeechSynthesisFailed } from "./provider.ts"

const maximumOutputBytes = 1024 * 1024
const terminationGraceMillis = 250
const killAcknowledgementMillis = 1000
const failed = () => new SpeechSynthesisFailed({ message: "Local synthesis process failed" })
const nativeFailureMessages: Partial<Record<typeof FailureReason.Type, string>> = {
  UnsupportedLanguage: "Apple speech detected a language without a configured voice",
  UncertainLanguage: "Apple speech could not determine the language of a foreign-script phrase",
  MissingVoice: "A configured Apple speech voice is unavailable",
  InvalidSynthesisRequest: "Apple speech rejected its synthesis request",
  SynthesisWriteFailed: "Apple speech could not write the generated audio",
  InvalidAudio: "Apple speech produced incomplete or invalid audio"
}
const processFailure = (text: string) => {
  try {
    const receipt = Schema.decodeUnknownOption(Schema.Struct({ reason: FailureReason }))(JSON.parse(text))
    if (Option.isSome(receipt))
      return new SpeechSynthesisFailed({
        reason: receipt.value.reason,
        message: nativeFailureMessages[receipt.value.reason] ?? "Local speech synthesis failed"
      })
  } catch {
    /* Unstructured process output is never published or logged. */
  }
  return new SpeechSynthesisFailed({ message: "Local synthesis process failed", reason: "NativeProcessFailed" })
}
// Internal process handle: Node owns this in-memory lifecycle, not a serialized boundary.
const start = (executable: string, args: readonly string[], input: string) => {
  const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"], shell: false })
  child.stdin.on("error", () => {})
  child.stdin.end(input)
  let bytes = 0
  let overflow = false
  const output: Buffer[] = []
  const collect = (chunk: Buffer) => {
    bytes += chunk.byteLength
    if (bytes > maximumOutputBytes) {
      overflow = true
      child.kill("SIGKILL")
    } else output.push(chunk)
  }
  child.stdout.on("data", collect)
  child.stderr.on("data", (chunk: Buffer) => {
    bytes += chunk.byteLength
    if (bytes > maximumOutputBytes) {
      overflow = true
      child.kill("SIGKILL")
    }
  })
  const closed = new Promise<number | null>((resolve) => {
    child.once("error", () => resolve(null))
    child.once("close", resolve)
  })
  const exited = new Promise<void>((resolve) => {
    child.once("error", () => resolve())
    child.once("exit", () => resolve())
  })
  return { child, closed, exited, result: () => ({ overflow, text: Buffer.concat(output).toString("utf8") }) }
}
const stop = (handle: ReturnType<typeof start>) =>
  Effect.gen(function* () {
    handle.child.stdout.destroy()
    handle.child.stderr.destroy()
    if (handle.child.exitCode !== null || handle.child.signalCode !== null) return
    handle.child.kill("SIGTERM")
    const reaped = yield* Effect.promise(() => handle.exited).pipe(Effect.timeoutOption(terminationGraceMillis))
    if (reaped._tag === "None") {
      handle.child.kill("SIGKILL")
      yield* Effect.promise(() => handle.exited).pipe(Effect.timeout(killAcknowledgementMillis), Effect.orDie)
    }
  })
export const runAppleProcess = (executable: string, args: readonly string[], input = "") =>
  Effect.gen(function* () {
    const handle = yield* Effect.acquireRelease(
      Effect.try({ try: () => start(executable, args, input), catch: failed }),
      stop
    )
    const code = yield* Effect.promise(() => handle.closed)
    const result = handle.result()
    if (code !== 0 || result.overflow) return yield* processFailure(result.text)
    return result.text
  }).pipe(Effect.scoped)
