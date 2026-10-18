import { AudioFrame } from "@livekit/rtc-node"
import { Deferred, Effect, Fiber } from "effect"
import { it as clockIt } from "@effect/vitest"
import { TestClock } from "effect/testing"
import { expect, it } from "vitest"
import { OperationAudit, operationAuditLayer } from "../src/operation-audit/index.ts"
import { drainLiveKitInput } from "../src/voice/livekit-input.ts"

const sessionId = "11111111-1111-4111-8111-111111111111"
const frame = new AudioFrame(new Int16Array(320), 16000, 1, 320)
type Reader = Parameters<typeof drainLiveKitInput>[0]["reader"]
const run = async (reader: Reader, current = () => true, deliver: (value: AudioFrame) => void = () => undefined) => {
  const lines: string[] = []
  let disconnected = 0
  await Effect.runPromise(
    drainLiveKitInput({
      reader,
      sessionId,
      generation: 1,
      current,
      frame: deliver,
      disconnected: () => {
        disconnected++
      }
    }).pipe(
      Effect.provide(
        operationAuditLayer({
          write: async (line) => {
            lines.push(line)
          }
        })
      )
    )
  )
  expect(lines.join("")).not.toContain("private")
  expect(lines.join("")).not.toContain(sessionId)
  return { records: lines.map((line): unknown => JSON.parse(line)), disconnected }
}

it("delivers current frames and independently audits both cleanup failures", async () => {
  let reads = 0
  const delivered: AudioFrame[] = []
  const result = await run(
    {
      read: async () => (reads++ === 0 ? { done: false, value: frame } : { done: true, value: undefined }),
      cancel: async () => {
        throw new Error("private cancel failure")
      },
      releaseLock: () => {
        throw new Error("private release failure")
      }
    },
    undefined,
    (value) => {
      delivered.push(value)
    }
  )
  expect(delivered).toEqual([frame])
  expect(result.disconnected).toBe(0)
  expect(result.records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "voice.release", outcome: "Failed", operation: "cancel" }),
      expect.objectContaining({ name: "voice.release", outcome: "Failed", operation: "release-lock" })
    ])
  )
})

it("exports a current read failure and notifies disconnection", async () => {
  const result = await run({
    read: async () => {
      throw new Error("private native read failure")
    },
    cancel: async () => undefined,
    releaseLock: () => undefined
  })
  expect(result.disconnected).toBe(1)
  expect(result.records).toContainEqual(
    expect.objectContaining({
      name: "voice.capture",
      outcome: "Failed",
      generation: 1,
      diagnostic: { category: "Media", reason: "Transport", provider: "livekit" }
    })
  )
})

it("treats a late read rejection as cancellation without disconnecting the replacement", async () => {
  let current = true
  const result = await run(
    {
      read: async () => {
        current = false
        throw new Error("private retired read")
      },
      cancel: async () => undefined,
      releaseLock: () => undefined
    },
    () => current
  )
  expect(result.disconnected).toBe(0)
  expect(result.records).toContainEqual(expect.objectContaining({ name: "voice.capture", outcome: "Cancelled" }))
})

it("fences a frame returned after its generation was retired", async () => {
  let current = true
  const delivered: AudioFrame[] = []
  const result = await run(
    {
      read: async () => {
        current = false
        return { done: false, value: frame }
      },
      cancel: async () => undefined,
      releaseLock: () => undefined
    },
    () => current,
    (value) => {
      delivered.push(value)
    }
  )
  expect(delivered).toEqual([])
  expect(result.disconnected).toBe(0)
})

clockIt.effect("bounds a stalled reader cancellation and still releases the native lock", () => {
  const lines: string[] = []
  return Effect.gen(function* () {
    const cancelling = yield* Deferred.make<void>()
    let released = false
    const fiber = yield* drainLiveKitInput({
      sessionId,
      generation: 1,
      current: () => true,
      frame: () => undefined,
      disconnected: () => undefined,
      reader: {
        read: async () => ({ done: true, value: undefined }),
        cancel: () => {
          Deferred.doneUnsafe(cancelling, Effect.void)
          return new Promise<void>(() => undefined)
        },
        releaseLock: () => {
          released = true
        }
      }
    }).pipe(Effect.forkChild)
    yield* Deferred.await(cancelling)
    yield* TestClock.adjust(1001)
    yield* Fiber.join(fiber)
    yield* (yield* OperationAudit).flush
    expect(released).toBe(true)
    expect(lines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        name: "voice.release",
        operation: "cancel",
        outcome: "Failed",
        diagnostic: { category: "Media", reason: "Deadline", provider: "livekit" }
      })
    )
  }).pipe(
    Effect.provide(
      operationAuditLayer({
        write: async (line) => {
          lines.push(line)
        }
      })
    )
  )
})
