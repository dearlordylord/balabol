import { it } from "@effect/vitest"
import { Cause, Effect, Exit, Fiber, Ref, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vitest"
import { AnswerGeneration, AnswerRequest, fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { SummaryGeneration, fakeSummaryLayer, configurableFakeSummaryLayer } from "../src/summary-generation/index.ts"

const answerRequest: AnswerRequest = {
  model: "sol",
  prior: "<chat>\n</chat>",
  input: "bonjour",
  capabilities: ["memory.context"]
}

it.effect("emits bounded ordered deltas and exactly one terminal using the configured clock", () =>
  Effect.gen(function* () {
    const answer = yield* AnswerGeneration
    const collected = yield* Effect.forkChild(Stream.runCollect(answer.generate(answerRequest)))
    yield* TestClock.adjust(1000)
    const events = yield* Fiber.join(collected)
    expect(events.at(-1)).toEqual({ kind: "Completed" })
    expect(events.filter((event) => event.kind === "Completed")).toHaveLength(1)
    expect(events.flatMap((event) => (event.kind === "Delta" ? [event.text] : [])).join("")).toBe(
      "[Fake sol] bonjour\nPrior memory: (empty)"
    )
  }).pipe(Effect.provide(fakeAnswerLayer(10)))
)

it.effect("interrupts a pending stream without delivering later deltas or success", () =>
  Effect.gen(function* () {
    const answer = yield* AnswerGeneration
    const observed = yield* Ref.make<ReadonlyArray<string>>([])
    const collecting = yield* Effect.forkChild(
      answer
        .generate(answerRequest)
        .pipe(Stream.runForEach((event) => Ref.update(observed, (events) => [...events, event.kind])))
    )
    yield* TestClock.adjust(10)
    expect(yield* Ref.get(observed)).toEqual(["Delta"])
    yield* Fiber.interrupt(collecting)
    yield* TestClock.adjust(1000)
    expect(yield* Ref.get(observed)).toEqual(["Delta"])
    const result = yield* Fiber.await(collecting)
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) expect(Cause.hasInterruptsOnly(result.cause)).toBe(true)
  }).pipe(Effect.provide(fakeAnswerLayer(10)))
)

it.effect("rejects malformed requests before any output and unsupported capabilities at decoding", () =>
  Effect.gen(function* () {
    const answer = yield* AnswerGeneration
    const result = yield* answer.generate({ ...answerRequest, input: "" }).pipe(Stream.runCollect, Effect.result)
    expect(result._tag).toBe("Failure")
    const unsupported = yield* Schema.decodeUnknownEffect(AnswerRequest)({
      ...answerRequest,
      capabilities: ["shell"]
    }).pipe(Effect.result)
    expect(unsupported._tag).toBe("Failure")
    const duplicate = yield* answer
      .generate({ ...answerRequest, capabilities: ["memory.context", "memory.context"] })
      .pipe(Stream.runCollect, Effect.result)
    expect(duplicate._tag).toBe("Failure")
  }).pipe(Effect.provide(fakeAnswerLayer(0)))
)

it.effect("fails invalid provider configuration in its typed error channel", () =>
  Effect.gen(function* () {
    const answer = yield* AnswerGeneration
    return yield* Stream.runCollect(answer.generate(answerRequest))
  }).pipe(
    Effect.provide(fakeAnswerLayer(-1)),
    Effect.result,
    Effect.map((result) => {
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure._tag).toBe("AnswerFailed")
    })
  )
)

it.effect("produces one complete bounded summary of a real unii request and rejects invalid attempts", () =>
  Effect.gen(function* () {
    const summary = yield* SummaryGeneration
    const request = {
      model: "luna",
      jobId: "0:1",
      attemptId: "0:1:1",
      attempt: 1,
      node: { level: 0, index: 1 },
      source: "bonjour",
      context: "",
      priorResponses: [],
      feedback: null
    }
    expect(yield* summary.summarize(request)).toBe("[Fake luna summary] bonjour")
    expect((yield* summary.summarize({ ...request, source: "x".repeat(1000001) }).pipe(Effect.result))._tag).toBe(
      "Failure"
    )
    expect((yield* summary.summarize({ ...request, attempt: 0 }).pipe(Effect.result))._tag).toBe("Failure")
    expect((yield* summary.summarize({ ...request, node: { level: -1, index: 0 } }).pipe(Effect.result))._tag).toBe(
      "Failure"
    )
  }).pipe(Effect.provide(fakeSummaryLayer))
)

it.effect("rejects invalid completed fake summaries and cancels delayed summary work", () =>
  Effect.gen(function* () {
    const summary = yield* SummaryGeneration
    const request = {
      model: "luna",
      jobId: "job",
      attemptId: "job:1",
      attempt: 1,
      node: { level: 0, index: 0 },
      source: "source",
      context: "",
      priorResponses: [],
      feedback: null
    }
    const task = yield* Effect.forkChild(summary.summarize(request))
    yield* TestClock.adjust(10)
    yield* Fiber.interrupt(task)
    yield* TestClock.adjust(1000)
    const cancelled = yield* Fiber.await(task)
    expect(Exit.isFailure(cancelled)).toBe(true)
    const invalid = yield* Effect.forkChild(summary.summarize({ ...request, jobId: "next" }).pipe(Effect.result))
    yield* TestClock.adjust(1000)
    const result = yield* Fiber.join(invalid)
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure._tag).toBe("SummaryFailed")
  }).pipe(
    Effect.provide(configurableFakeSummaryLayer({ failFirstJob: false, delayMillis: 100, invalidCompletion: true }))
  )
)
