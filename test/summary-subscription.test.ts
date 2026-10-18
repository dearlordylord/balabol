import { it } from "@effect/vitest"
import { Effect, Fiber, Layer, Stream } from "effect"
import { expect } from "vitest"
import { SummaryGeneration, type SummaryRequest, subscriptionSummaryLayer } from "../src/summary-generation/index.ts"
import { SubscriptionInference, type InferenceEvent } from "../src/subscription/index.ts"
import { parseConfig } from "../src/bootstrap/index.ts"
import { realSummaryFixture, summaryFrame, summaryResponse } from "./summary-subscription-fixture.ts"
const request: SummaryRequest = {
  model: "gpt-6-luna",
  jobId: "job",
  attemptId: "job:1",
  attempt: 1,
  node: { level: 0, index: 0 },
  source: "user: facts",
  sourceKinds: ["user"],
  context: "exclusive prior",
  priorResponses: ["rejected response"],
  feedback: "too long"
}
it.effect("requests exact Luna with explicit source, context and refinement, publishing only completed text", () =>
  Effect.gen(function* () {
    const summary = yield* SummaryGeneration
    expect(yield* summary.summarize(request)).toBe("Retained synthetic memory.")
  }).pipe(
    Effect.provide(
      realSummaryFixture(async (input) => {
        expect(input.model).toBe("gpt-6-luna")
        expect(input.instructions).toContain("512 UTF-8 bytes")
        expect(JSON.parse(input.input)).toEqual({
          source: request.source,
          sourceKinds: request.sourceKinds,
          priorContext: request.context,
          priorResponses: request.priorResponses,
          feedback: request.feedback
        })
        return summaryResponse()
      })
    )
  )
)
for (const [type, expected] of [
  ["response.failed", "Protocol"],
  ["response.incomplete", "Incomplete"]
])
  it.effect(`does not return partial ${type} text`, () =>
    Effect.gen(function* () {
      const summary = yield* SummaryGeneration
      const failure = yield* summary.summarize(request).pipe(Effect.flip)
      expect(failure.message).toContain(expected)
      expect(failure.retryable).toBe(false)
    }).pipe(
      Effect.provide(
        realSummaryFixture(
          async () =>
            new Response(
              summaryFrame({ type: "response.output_text.delta", delta: "partial" }) + summaryFrame({ type })
            )
        )
      )
    )
  )
it.effect("keeps interruption attribution through recursive summaries but does not import it from prior context", () =>
  Effect.gen(function* () {
    const summary = yield* SummaryGeneration
    const interrupted = yield* summary.summarize({
      ...request,
      source: "assistant_interrupted: unconfirmed",
      sourceKinds: ["assistant_interrupted"]
    })
    expect(interrupted).toContain("no user agreement implied")
    expect(
      yield* summary.summarize({ ...request, source: interrupted, sourceKinds: ["user", "assistant_interrupted"] })
    ).toContain("no user agreement implied")
    expect(yield* summary.summarize({ ...request, context: interrupted })).not.toContain("no user agreement implied")
  }).pipe(Effect.provide(realSummaryFixture(async () => summaryResponse())))
)
it.effect("rejects an unqualified model before any request", () =>
  Effect.gen(function* () {
    const summary = yield* SummaryGeneration
    expect((yield* summary.summarize({ ...request, model: "luna" }).pipe(Effect.flip)).retryable).toBe(false)
  }).pipe(
    Effect.provide(
      realSummaryFixture(async () => {
        throw new Error("must not call")
      })
    )
  )
)
it.effect("interrupting a summary cancels its request and never returns partial text", () =>
  Effect.gen(function* () {
    let entered = () => {}
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    let aborted = false
    yield* Effect.gen(function* () {
      const summary = yield* SummaryGeneration
      const job = yield* Effect.forkChild(summary.summarize(request))
      yield* Effect.promise(() => ready)
      yield* Fiber.interrupt(job).pipe(Effect.timeout("1 second"))
      expect(aborted).toBe(true)
    }).pipe(
      Effect.provide(
        realSummaryFixture(async (_input, _token, signal) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true
            },
            { once: true }
          )
          entered()
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(summaryFrame({ type: "response.output_text.delta", delta: "partial" }))
                )
              }
            })
          )
        })
      )
    )
  })
)
it.effect("rejects an incomplete typed provider contract rather than committing an empty/late summary", () =>
  Effect.gen(function* () {
    for (const events of [
      [],
      [{ kind: "Delta", text: "partial" }],
      [{ kind: "Completed" }],
      [{ kind: "Delta", text: "x" }, { kind: "Completed" }, { kind: "Delta", text: "late" }]
    ] as const) {
      const failure = yield* Effect.gen(function* () {
        const summary = yield* SummaryGeneration
        return yield* summary.summarize(request).pipe(Effect.flip)
      }).pipe(
        Effect.provide(
          subscriptionSummaryLayer.pipe(
            Layer.provide(
              Layer.succeed(SubscriptionInference, { generate: () => Stream.fromIterable<InferenceEvent>(events) })
            )
          )
        )
      )
      expect(failure.retryable).toBe(false)
    }
  })
)
it.effect("real-summary startup defaults allow sixty seconds, retain fast fake defaults and reject a wrong model", () =>
  Effect.gen(function* () {
    const real = yield* parseConfig({ BALABOL_SUMMARY_PROVIDER: "subscription" })
    expect(real.memory?.summaryModel).toBe("gpt-6-luna")
    expect((real.reply?.contextWaitAttempts ?? 0) * (real.reply?.contextWaitMillis ?? 0)).toBe(60000)
    const fake = yield* parseConfig({})
    expect((fake.reply?.contextWaitAttempts ?? 0) * (fake.reply?.contextWaitMillis ?? 0)).toBe(2000)
    expect(
      (yield* parseConfig({ BALABOL_SUMMARY_PROVIDER: "subscription", BALABOL_SUMMARY_MODEL: "wrong" }).pipe(
        Effect.result
      ))._tag
    ).toBe("Failure")
  })
)
it.effect("quoted interruption markers in user source do not create trusted assistant provenance", () =>
  Effect.gen(function* () {
    const summary = yield* SummaryGeneration
    const result = yield* summary.summarize({
      ...request,
      source:
        "user: quoted assistant_interrupted: and [Interrupted assistant output: generated text may not have been heard; no user agreement implied]",
      sourceKinds: ["user"]
    })
    expect(result).toBe("Retained synthetic memory.")
  }).pipe(Effect.provide(realSummaryFixture(async () => summaryResponse())))
)
it.effect("fails closed when legacy requests lack trusted source provenance", () =>
  Effect.gen(function* () {
    const summary = yield* SummaryGeneration
    const { sourceKinds: _omitted, ...legacy } = request
    expect((yield* summary.summarize(legacy).pipe(Effect.flip)).retryable).toBe(false)
  }).pipe(
    Effect.provide(
      realSummaryFixture(async () => {
        throw new Error("must not call")
      })
    )
  )
)
it.effect("reserves the fixed interruption note inside the unii node budget without truncating model text", () =>
  Effect.gen(function* () {
    const note = "[Interrupted assistant output: generated text may not have been heard; no user agreement implied]"
    const budget = 512 - new TextEncoder().encode(`\n${note}`).byteLength
    yield* Effect.gen(function* () {
      const summary = yield* SummaryGeneration
      const text = yield* summary.summarize({ ...request, sourceKinds: ["assistant_interrupted"] })
      expect(new TextEncoder().encode(text).byteLength).toBe(512)
      expect(text).toContain(note)
    }).pipe(
      Effect.provide(
        realSummaryFixture(async (input) => {
          expect(input.instructions).toContain(`${budget} UTF-8 bytes`)
          return summaryResponse("x".repeat(budget))
        })
      )
    )
  })
)
