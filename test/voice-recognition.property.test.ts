import { HashMap } from "effect"
import fc from "fast-check"
import { expect, it } from "vitest"
import { initialRecognition, readyFinal, transitionRecognition } from "../src/voice/recognition-transition.ts"
import type { RecognitionInput, RecognitionCommand } from "../src/voice/recognition-events.ts"
import type { RecognitionState, RecognitionJob } from "../src/voice/recognition-state.ts"

const harness = (windowSize = 512) => {
  let state = initialRecognition(1)
  let identity = 0
  const commands: RecognitionCommand[] = []
  const step = (event: RecognitionInput) => {
    const result = transitionRecognition(state, event, ["en", "fr"])
    state = result.state
    commands.push(...result.commands)
    return result
  }
  const feed = (samples: number, speech: boolean) => {
    for (let remaining = samples; remaining > 0; remaining -= windowSize) {
      identity += 1
      step({
        kind: "Window",
        generation: state.generation,
        fragmentId: `fragment-${identity}`,
        sampleFrames: Math.min(windowSize, remaining),
        speech,
        turnId: `turn-${identity}`,
        fenceId: `fence-${identity}`,
        requestId: `request-${identity}`
      })
    }
  }
  return { step, feed, commands, state: () => state }
}
const finalPacket = (job: RecognitionJob, text = "complete") => ({
  kind: "Packet" as const,
  operation: job.operation,
  generation: job.generation,
  event: { kind: "Final" as const, utteranceId: job.requestId, text, spans: [], detectedLanguage: "en" }
})
const assertOwners = (state: RecognitionState) => {
  const expected = new Map<string, number>()
  for (const slices of [
    state.segment.slices,
    ...state.queue.map((chunk) => chunk.slices),
    ...state.jobs.map((job) => job.slices)
  ]) {
    for (const id of new Set(slices.map((slice) => slice.fragmentId))) expected.set(id, (expected.get(id) ?? 0) + 1)
  }
  expect(new Map(HashMap.entries(state.fragmentOwners))).toEqual(expected)
  expect(state.jobs.length).toBeLessThanOrEqual(2)
  expect(new Set(state.jobs.map((job) => job.operation)).size).toBe(state.jobs.length)
  expect(state.turn?.chunks ?? 0).toBeLessThanOrEqual(30)
}

it("reserves two slots before JobStarted and holds cancellation slots until exact settlement", () => {
  fc.assert(
    fc.property(fc.constantFrom(320, 512), fc.boolean(), (windowSize, reverse) => {
      const run = harness(windowSize)
      run.feed(480000, true)
      expect(run.state().jobs.map((job) => job.status)).toEqual(["Reserved", "Reserved"])
      expect(run.commands.filter((command) => command.kind === "Recognize")).toHaveLength(2)
      expect(run.state().queue).toHaveLength(1)
      const old = [...run.state().jobs]
      if (reverse) old.reverse()
      run.step({ kind: "Reset", generation: 2 })
      run.feed(160000, true)
      expect(run.state().jobs.map((job) => job.status)).toEqual(["Cancelling", "Cancelling"])
      expect(run.state().queue).toHaveLength(1)
      expect(run.commands.filter((command) => command.kind === "Recognize")).toHaveLength(2)
      for (const job of old) {
        const before = run.state()
        expect(run.step(finalPacket(job)).state).toBe(before)
        expect(
          run.step({ kind: "Settled", operation: job.operation, generation: 99, outcome: { kind: "Success" } }).state
        ).toBe(before)
        run.step({
          kind: "Settled",
          operation: job.operation,
          generation: job.generation,
          outcome: { kind: "Interrupted" }
        })
        assertOwners(run.state())
      }
      expect(run.state().jobs).toHaveLength(1)
      expect(run.state().jobs[0]?.generation).toBe(2)
      expect(run.state().jobs[0]?.status).toBe("Reserved")
      expect(run.commands.filter((command) => command.kind === "Recognize")).toHaveLength(3)
    }),
    { numRuns: 8 }
  )
})

it("generated reset and completion histories preserve fragment ownership and bounded reservations", () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom("speech", "quiet", "boundary", "reset", "start", "final", "settle"), {
        minLength: 20,
        maxLength: 60
      }),
      (events) => {
        const run = harness()
        run.feed(320000, true)
        for (const event of events) {
          const job = run.state().jobs[0]
          switch (event) {
            case "speech":
              run.feed(1024, true)
              break
            case "quiet":
              run.feed(16000, false)
              break
            case "boundary":
              run.step({
                kind: "CaptureBoundary",
                generation: run.state().generation + 1,
                requestId: `boundary-${run.state().generation}`
              })
              break
            case "reset":
              run.step({ kind: "Reset", generation: run.state().generation + 1 })
              break
            case "start":
              if (job) run.step({ kind: "JobStarted", operation: job.operation, generation: job.generation })
              break
            case "final":
              if (job) run.step(finalPacket(job))
              break
            case "settle":
              if (job)
                run.step({
                  kind: "Settled",
                  operation: job.operation,
                  generation: job.generation,
                  outcome: { kind: "Success" }
                })
              break
          }
          assertOwners(run.state())
          const owned = new Set(HashMap.keys(run.state().fragmentOwners))
          for (const command of run.commands.filter((command) => command.kind === "ReleaseFragment"))
            expect(owned.has(command.fragmentId)).toBe(false)
        }
        run.step({ kind: "Reset", generation: run.state().generation + 1 })
        for (const job of [...run.state().jobs])
          run.step({
            kind: "Settled",
            operation: job.operation,
            generation: job.generation,
            outcome: { kind: "Interrupted" }
          })
        expect(HashMap.size(run.state().fragmentOwners)).toBe(0)
        expect(run.state().jobs).toEqual([])
      }
    ),
    { numRuns: 20 }
  )
})

it("commits a candidate only on clean EOF and hands the complete quiet turn once", () => {
  const run = harness(320)
  run.feed(960, true)
  run.feed(16000, false)
  const job = run.state().jobs[0]
  if (!job) throw new Error("Expected a reserved recognition request")
  run.step({ kind: "JobStarted", operation: job.operation, generation: job.generation })
  run.step(finalPacket(job))
  expect(readyFinal(run.state())).toBeNull()
  run.step({ kind: "Settled", operation: job.operation, generation: job.generation, outcome: { kind: "Success" } })
  const ready = readyFinal(run.state())
  expect(ready?.text).toBe("complete")
  expect(HashMap.size(run.state().fragmentOwners)).toBe(0)
  if (!ready) throw new Error("Expected the complete turn")
  run.step({ kind: "Handed", generation: ready.generation, turnId: ready.turnId })
  expect(readyFinal(run.state())).toBeNull()
  expect(run.state().turn).toBeNull()
})

it("preserves a newer subthreshold onset when the prior quiet turn fails, but releases it on reset", () => {
  const run = harness(320)
  run.feed(960, true)
  run.feed(16000, false)
  const previous = run.state().jobs[0]
  if (!previous) throw new Error("Expected the prior recognition")
  run.feed(640, true)
  run.step({
    kind: "Settled",
    operation: previous.operation,
    generation: previous.generation,
    outcome: { kind: "Failure", error: { code: "RecognitionFailed", message: "Prior turn failed" } }
  })
  expect(run.state().segment.kind).toBe("Idle")
  expect(run.state().segment.samples).toBe(640)
  expect(run.state().turn).toBeNull()
  assertOwners(run.state())
  run.feed(320, true)
  expect(run.state().segment.samples).toBe(960)
  expect(run.state().turn).not.toBeNull()
  run.step({ kind: "Reset", generation: 2 })
  expect(HashMap.size(run.state().fragmentOwners)).toBe(0)
})

for (const scenario of [
  {
    name: "exactly 100000 text-budget units",
    text: "a".repeat(49999),
    spans: [],
    expectedLength: 99999,
    expectedSpans: 0
  },
  {
    name: "exactly 1000 language spans",
    text: "ab".repeat(500),
    spans: Array.from({ length: 500 }, (_, index) => ({ language: "en", start: index * 2, end: index * 2 + 1 })),
    expectedLength: 2001,
    expectedSpans: 1000
  }
])
  it(`accepts ${scenario.name} without changing aggregate accounting`, () => {
    const run = harness(320)
    for (let chunk = 0; chunk < 2; chunk++) {
      run.feed(960, true)
      run.feed(16000, false)
    }
    for (const job of [...run.state().jobs]) {
      run.step({ kind: "JobStarted", operation: job.operation, generation: job.generation })
      run.step({
        ...finalPacket(job, scenario.text),
        event: { ...finalPacket(job, scenario.text).event, spans: scenario.spans }
      })
      run.step({ kind: "Settled", operation: job.operation, generation: job.generation, outcome: { kind: "Success" } })
    }
    expect(readyFinal(run.state())?.text.length).toBe(scenario.expectedLength)
    expect(readyFinal(run.state())?.languageSpans).toHaveLength(scenario.expectedSpans)
    expect(run.commands.some((command) => command.kind === "Error")).toBe(false)
    assertOwners(run.state())
  })
