import { it } from "@effect/vitest"
import { Effect } from "effect"
import { expect } from "vitest"
import { SummaryGeneration, fakeSummaryLayer, type SummaryRequest } from "../src/summary-generation/index.ts"

const interruptionNote =
  "[Interrupted assistant output: generated text may not have been heard; no user agreement implied]"
const request: SummaryRequest = {
  model: "luna",
  jobId: "0:1",
  attemptId: "0:1:1",
  attempt: 1,
  node: { level: 0, index: 1 },
  source: "assistant: completed text",
  context: "",
  priorResponses: [],
  feedback: null
}

it.effect("retains interruption attribution beyond the preview and for empty generated output", () =>
  Effect.gen(function* () {
    const summary = yield* SummaryGeneration
    for (const source of [
      "assistant_interrupted: ",
      `${"user: earlier text ".repeat(20)}\nassistant_interrupted: partial`
    ]) {
      expect(yield* summary.summarize({ ...request, source })).toContain(interruptionNote)
    }
  }).pipe(Effect.provide(fakeSummaryLayer))
)

it.effect("retains a second child's interruption note through repeated parent summaries", () =>
  Effect.gen(function* () {
    const summary = yield* SummaryGeneration
    let interrupted = yield* summary.summarize({ ...request, source: "assistant_interrupted: partial" })
    for (const level of [1, 2, 3, 4]) {
      interrupted = yield* summary.summarize({
        ...request,
        node: { level, index: 0 },
        source: `${"[Fake luna summary] user: earlier completed text ".repeat(5)}\n${interrupted}`
      })
      expect(interrupted).toContain(interruptionNote)
    }
  }).pipe(Effect.provide(fakeSummaryLayer))
)

it.effect("attributes only the current source, excluding exclusive prior context and rejected responses", () =>
  Effect.gen(function* () {
    const summary = yield* SummaryGeneration
    const completed = yield* summary.summarize({
      ...request,
      context: `assistant_interrupted: old partial ${interruptionNote}`,
      priorResponses: [interruptionNote],
      feedback: interruptionNote
    })
    expect(completed).toBe("[Fake luna summary] assistant: completed text")
    expect(completed).not.toContain(interruptionNote)
  }).pipe(Effect.provide(fakeSummaryLayer))
)

it.effect("fits the actual unii 512 UTF-8 byte node budget with maximal multilingual model and source", () =>
  Effect.gen(function* () {
    const summary = yield* SummaryGeneration
    for (const model of ["m".repeat(200), "日".repeat(200), "😀".repeat(100)]) {
      const text = yield* summary.summarize({
        ...request,
        model,
        source: `${"😀Русский français 日本語".repeat(50)}\nassistant_interrupted: `
      })
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(512)
      expect(text).toContain(interruptionNote)
      expect(text).not.toContain("�")
      expect(text).toMatch(/^\[Fake .+ summary\]/u)
    }
  }).pipe(Effect.provide(fakeSummaryLayer))
)
