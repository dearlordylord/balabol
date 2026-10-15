import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { maximumActivityLineBytes, parseActivityResponse } from "./activity-protocol.ts"
import type { ActivityCommand, ActivityResponse } from "./activity-protocol.ts"
const lineFeedByte = 10
const terminationGraceMillis = 100
const killReapMillis = 400
const maximumStderrBytes = 4096
const error = () => new Error("Speech activity worker failed")
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
  const reject = () => {
    pending?.reject(error())
    pending = undefined
  }
  const reaped = new Promise<void>((resolve) => {
    const finish = () => {
      exited = true
      reject()
      resolve()
    }
    child.once("error", finish)
    child.once("exit", finish)
  })
  const accept = (line: string) => {
    const result = parseActivityResponse(line)
    if (pending === undefined || result.sequence !== pending.sequence) throw error()
    pending.resolve(result)
    pending = undefined
  }
  child.stdout.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    if (buffer.length > maximumActivityLineBytes) {
      child.kill("SIGKILL")
      reject()
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
      reject()
    }
  })
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length
    if (stderrBytes > maximumStderrBytes) {
      child.kill("SIGKILL")
      reject()
    }
  })
  child.stdin.on("error", reject)
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
            acknowledgement = setTimeout(() => rejectExit(error()), terminationGraceMillis + killReapMillis)
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
          rejectRequest(error())
          return
        }
        const deadline = setTimeout(() => {
          void stop().then(() => rejectRequest(error()), rejectRequest)
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
          pending.reject(error())
          pending = undefined
          return
        }
        child.stdin.write(serialized)
      })
  }
}
