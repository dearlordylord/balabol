import { spawn } from "node:child_process"
import { Effect } from "effect"
import { SpeechSynthesisFailed } from "./provider.ts"

const maximumOutputBytes = 1024 * 1024
const terminationGraceMillis = 250
const killAcknowledgementMillis = 1000
const failed = () => new SpeechSynthesisFailed({ message: "Local synthesis process failed" })
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
    if (code !== 0 || result.overflow) return yield* failed()
    return result.text
  }).pipe(Effect.scoped)
