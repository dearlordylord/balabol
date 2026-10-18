import { it } from "@effect/vitest"
import { Effect, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vitest"
import { InferenceFailed, inferenceFailed } from "../src/subscription/inference-model.ts"
import { retryToolInference } from "../src/subscription/tool-retry.ts"
import type { ToolInferenceEvent } from "../src/subscription/tool-model.ts"

const completed: ToolInferenceEvent = { kind: "Completed", finishReason: "stop" }
const delta: ToolInferenceEvent = { kind: "Delta", text: "Hello" }
it.effect("retries the same model step with 1s and 3s backoff and observable attempts", () =>
  Effect.gen(function* () {
    let attempts = 0
    const progress: number[] = []
    const stream = retryToolInference(
      () => {
        attempts++
        return attempts < 3 ? Stream.fail(inferenceFailed("Transport")) : Stream.make(delta, completed)
      },
      ({ attempt }) =>
        Effect.sync(() => {
          progress.push(attempt)
        })
    )
    const running = yield* Effect.forkChild(Stream.runCollect(stream))
    yield* TestClock.adjust(999)
    expect(attempts).toBe(1)
    expect(progress).toEqual([2])
    yield* TestClock.adjust(1)
    expect(attempts).toBe(2)
    expect(progress).toEqual([2, 3])
    yield* TestClock.adjust(2999)
    expect(attempts).toBe(2)
    yield* TestClock.adjust(1)
    expect(yield* Fiber.join(running)).toEqual([delta, completed])
    expect(attempts).toBe(3)
  })
)
it.effect("exhausts after exactly three provider failures", () =>
  Effect.gen(function* () {
    let attempts = 0
    const running = yield* Effect.forkChild(
      Stream.runCollect(
        retryToolInference(() => {
          attempts++
          return Stream.fail(inferenceFailed("Failed"))
        })
      ).pipe(Effect.flip)
    )
    yield* TestClock.adjust(4000)
    expect((yield* Fiber.join(running)).reason).toBe("Failed")
    expect(attempts).toBe(3)
  })
)
for (const reason of ["Authentication", "Quota", "Protocol", "Limit", "Incomplete"] as const)
  it.effect(`does not retry ${reason}`, () =>
    Effect.gen(function* () {
      let attempts = 0
      const error = yield* Stream.runCollect(
        retryToolInference(() => {
          attempts++
          return Stream.fail(inferenceFailed(reason))
        })
      ).pipe(Effect.flip)
      expect(error.reason).toBe(reason)
      expect(attempts).toBe(1)
    })
  )
it.effect("does not retry invalid HTTP requests or credential store failures", () =>
  Effect.gen(function* () {
    for (const diagnostic of [
      { category: "Subscription", reason: "Failed", provider: "subscription", status: 400 },
      { category: "Subscription", reason: "Storage", provider: "subscription" }
    ] as const) {
      let attempts = 0
      yield* Stream.runCollect(
        retryToolInference(() => {
          attempts++
          return Stream.fail(new InferenceFailed({ reason: "Failed", diagnostic }))
        })
      ).pipe(Effect.flip)
      expect(attempts).toBe(1)
    }
  })
)
it.effect("cancellation during backoff dispatches no further request", () =>
  Effect.gen(function* () {
    let attempts = 0
    const running = yield* Effect.forkChild(
      Stream.runCollect(
        retryToolInference(() => {
          attempts++
          return Stream.fail(inferenceFailed("Transport"))
        })
      )
    )
    yield* TestClock.adjust(500)
    yield* Fiber.interrupt(running)
    yield* TestClock.adjust(10000)
    expect(attempts).toBe(1)
  })
)
for (const event of [
  delta,
  { kind: "Reasoning", item: { type: "reasoning", id: "r", summary: [], encrypted_content: "opaque" } },
  { kind: "ToolCall", id: "fc", callId: "call", name: "write", arguments: "{}" }
] as const)
  it.effect(`never replays released ${event.kind}`, () =>
    Effect.gen(function* () {
      let attempts = 0
      const seen: ToolInferenceEvent[] = []
      const running = yield* retryToolInference(() => {
        attempts++
        return attempts === 1
          ? Stream.succeed(event).pipe(Stream.concat(Stream.fail(inferenceFailed("Transport"))))
          : Stream.succeed(completed)
      }).pipe(
        Stream.tap((value) =>
          Effect.sync(() => {
            seen.push(value)
          })
        ),
        Stream.runDrain,
        Effect.result,
        Effect.forkChild
      )
      for (let tick = 0; tick < 4; tick++) yield* TestClock.adjust(1000)
      const result = yield* Fiber.join(running)
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure.reason).toBe("Transport")
      expect(attempts).toBe(1)
      expect(seen).toEqual([event])
    })
  )
it.effect("the total deadline includes all attempts and backoff", () =>
  Effect.gen(function* () {
    let attempts = 0
    const running = yield* Effect.forkChild(
      Stream.runCollect(
        retryToolInference(() => {
          attempts++
          return attempts === 1 ? Stream.fail(inferenceFailed("Transport")) : Stream.never
        })
      ).pipe(Effect.flip)
    )
    yield* TestClock.adjust(60000)
    expect((yield* Fiber.join(running)).reason).toBe("Deadline")
    expect(attempts).toBe(2)
  })
)
