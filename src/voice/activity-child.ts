import { activityFailure, type ActivityFailureReason } from "./activity-failure.ts"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { maximumActivityLineBytes, parseActivityResponse } from "./activity-protocol.ts"
import type { ActivityCommand, ActivityResponse } from "./activity-protocol.ts"
const lineFeedByte = 10
const terminationGraceMillis = 100
const killReapMillis = 400
const maximumStderrBytes = 4096
export const activityWorkerEntrypoint = new URL(
  import.meta.url.endsWith(".ts") ? "./activity-worker.ts" : "./activity-worker.js",
  import.meta.url
)
export const startActivityChild = (entrypoint: URL) => {
  const child = spawn(process.execPath, [fileURLToPath(entrypoint)], {
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    env: {}
  })
  let exited = false
  let closed = false
  let buffer = Buffer.alloc(0)
  let stderrBytes = 0
  let pending:
    | { sequence: number; resolve: (value: ActivityResponse) => void; reject: (reason: unknown) => void }
    | undefined
  const reject = (reason: ActivityFailureReason = "ProcessExit") => {
    pending?.reject(activityFailure(reason))
    pending = undefined
  }
  const reaped = new Promise<void>((resolve) => {
    const finish = (reason: ActivityFailureReason) => {
      exited = true
      reject(reason)
      resolve()
    }
    child.once("error", () => finish("ProcessStart"))
    child.once("exit", () => finish("ProcessExit"))
  })
  const accept = (line: string) => {
    const result = parseActivityResponse(line)
    if (pending === undefined || result.sequence !== pending.sequence) throw activityFailure("ProcessProtocol")
    pending.resolve(result)
    pending = undefined
  }
  child.stdout.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    if (buffer.length > maximumActivityLineBytes) {
      child.kill("SIGKILL")
      reject("ProcessOutputLimit")
      return
    }
    const newline = buffer.indexOf(lineFeedByte)
    if (newline < 0) return
    const bytes = buffer.subarray(0, newline)
    buffer = buffer.subarray(newline + 1)
    try {
      accept(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    } catch {
      child.kill("SIGKILL")
      reject("ProcessProtocol")
    }
  })
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length
    if (stderrBytes > maximumStderrBytes) {
      child.kill("SIGKILL")
      reject("ProcessOutputLimit")
    }
  })
  child.stdin.on("error", () => reject("ProcessProtocol"))
  let stopping: Promise<void> | undefined
  const stop = () =>
    (stopping ??= (async () => {
      closed = true
      reject()
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
      if (exited) return
      child.kill("SIGTERM")
      const kill = setTimeout(() => child.kill("SIGKILL"), terminationGraceMillis)
      let acknowledgement: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          reaped,
          new Promise<never>((_resolve, rejectExit) => {
            acknowledgement = setTimeout(
              () => rejectExit(activityFailure("Deadline")),
              terminationGraceMillis + killReapMillis
            )
          })
        ])
      } finally {
        clearTimeout(kill)
        clearTimeout(acknowledgement)
      }
    })())
  return {
    stop,
    get alive() {
      return !closed && !exited
    },
    exchange: (command: ActivityCommand, timeoutMillis: number) =>
      new Promise<ActivityResponse>((resolve, rejectRequest) => {
        if (closed || exited || pending !== undefined) {
          rejectRequest(activityFailure("Unavailable"))
          return
        }
        const deadline = setTimeout(() => {
          reject("Deadline")
          void stop().catch(rejectRequest)
        }, timeoutMillis)
        pending = {
          sequence: command.sequence,
          resolve: (value) => {
            clearTimeout(deadline)
            resolve(value)
          },
          reject: (reason) => {
            clearTimeout(deadline)
            rejectRequest(reason)
          }
        }
        const serialized = `${JSON.stringify(command)}\n`
        if (Buffer.byteLength(serialized) > maximumActivityLineBytes) {
          pending.reject(activityFailure("InvalidRequest"))
          pending = undefined
          return
        }
        child.stdin.write(serialized)
      })
  }
}
