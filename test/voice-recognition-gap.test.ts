import { expect, it } from "vitest"
import { initialRecognition, readyFinal, transitionRecognition } from "../src/voice/recognition-transition.ts"
import type { RecognitionInput, RecognitionCommand } from "../src/voice/recognition-events.ts"
import type { RecognitionJob } from "../src/voice/recognition-state.ts"

const capture = () => {
  let state = initialRecognition(1)
  let id = 0
  const commands: RecognitionCommand[] = []
  const step = (event: RecognitionInput) => {
    const result = transitionRecognition(state, event, ["en"])
    state = result.state
    commands.push(...result.commands)
    return result
  }
  const feed = (count: number, speech: boolean) => {
    for (let index = 0; index < count; index++) {
      id++
      step({
        kind: "Window",
        generation: state.generation,
        fragmentId: `f-${id}`,
        sampleFrames: 320,
        speech,
        turnId: `t-${id}`,
        fenceId: `fence-${id}`,
        requestId: `request-${id}`
      })
    }
  }
  return { step, feed, state: () => state, commands }
}
const final = (job: RecognitionJob) => ({
  kind: "Packet" as const,
  operation: job.operation,
  generation: job.generation,
  event: {
    kind: "Final" as const,
    utteranceId: job.requestId,
    text: "Complete sealed speech",
    spans: [],
    detectedLanguage: "en"
  }
})
it("preserves sealed recognition across a microphone gap and admits its exact late result", () => {
  const run = capture()
  run.feed(3, true)
  run.feed(50, false)
  const before = run.state()
  const job = before.jobs[0]
  if (job === undefined) throw new Error("Expected sealed recognition job")
  expect(before.turn?.ended).toBe(true)
  const gap = run.step({ kind: "Gap", generation: 2 })
  expect(gap.state.jobs).toBe(before.jobs)
  expect(gap.state.turn).toBe(before.turn)
  expect(gap.commands.some((command) => command.kind === "Cancel")).toBe(false)
  run.step({ kind: "JobStarted", operation: job.operation, generation: job.generation })
  run.step(final(job))
  run.step({ kind: "Settled", operation: job.operation, generation: job.generation, outcome: { kind: "Success" } })
  expect(readyFinal(run.state())?.text).toBe("Complete sealed speech")
  expect(readyFinal(run.state())?.generation).toBe(1)
})
it("abandons an unsealed chunked utterance and rejects its later recognition, without joining speech across the gap", () => {
  const run = capture()
  run.feed(500, true)
  const job = run.state().jobs[0]
  if (job === undefined) throw new Error("Expected unfinished recognition chunk")
  const gap = run.step({ kind: "Gap", generation: 2 })
  expect(gap.state.turn).toBeNull()
  expect(gap.state.jobs[0]?.status).toBe("Cancelling")
  expect(gap.commands).toContainEqual({ kind: "Cancel", operation: job.operation })
  run.step(final(job))
  expect(readyFinal(run.state())).toBeNull()
  run.feed(3, true)
  expect(run.state().turn).toBeNull()
  run.feed(50, false)
  run.feed(3, true)
  expect(run.state().turn?.generation).toBe(2)
  expect(run.state().turn?.results).toEqual([])
})
it("releases partial onset PCM and requires quiet before accepting a new onset", () => {
  const run = capture()
  run.feed(2, true)
  const gap = run.step({ kind: "Gap", generation: 2 })
  expect(gap.commands.filter((command) => command.kind === "ReleaseFragment")).toHaveLength(2)
  expect(gap.state.segment.slices).toEqual([])
  run.feed(2, true)
  expect(run.state().turn).toBeNull()
  run.feed(50, false)
  run.feed(3, true)
  expect(run.state().turn?.generation).toBe(2)
})
