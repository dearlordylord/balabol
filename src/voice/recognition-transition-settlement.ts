import type { RecognitionInput } from "./recognition-events.ts"
import type { RecognitionState, RecognitionJob, RecognitionFinal } from "./recognition-state.ts"
import { findRecognitionJob, currentRecognitionJob, pumpRecognition } from "./recognition-transition-jobs.ts"
import { failRecognitionTurn } from "./recognition-transition-reset.ts"
import { releaseSlices } from "./recognition-transition-fragments.ts"
import { prepareRecognitionFinal } from "./recognition-transition-assembly.ts"
import { continueRecognition, unchangedRecognition } from "./recognition-transition-result.ts"
import type { RecognitionTransition } from "./recognition-transition-result.ts"
const maximumText = 100000
const maximumSpans = 1000
type Settled = Extract<RecognitionInput, { kind: "Settled" }>
const complete = (state: RecognitionState, job: RecognitionJob, final: RecognitionFinal): RecognitionTransition => {
  const turn = state.turn
  if (turn === null) return unchangedRecognition(state)
  const textLength = turn.textLength + final.text.length + 1
  const spanCount = turn.spanCount + final.spans.length
  if (textLength > maximumText || spanCount > maximumSpans)
    return failRecognitionTurn(state, {
      code: "RecognitionFailed",
      message: "Spoken turn exceeds transcript capacity",
      reason: "Other"
    })
  const result = prepareRecognitionFinal({
    ...state,
    turn: { ...turn, textLength, spanCount, results: [...turn.results, { index: job.index, final }], ready: null }
  })
  return { state: result.state, commands: [{ kind: "Trace", cause: "recognitionSucceeded" }, ...result.commands] }
}
const outcome = (state: RecognitionState, job: RecognitionJob, event: Settled): RecognitionTransition => {
  switch (event.outcome.kind) {
    case "Defect":
    case "Failure":
      return failRecognitionTurn(state, event.outcome.error)
    case "Interrupted":
      return failRecognitionTurn(state, {
        code: "RecognitionFailed",
        message: "Recognition stream was interrupted",
        reason: "Other"
      })
    case "Success":
      return job.candidate === null
        ? failRecognitionTurn(state, {
            code: "RecognitionFailed",
            message: "Recognition stream ended without final",
            reason: "Final"
          })
        : complete(state, job, job.candidate)
  }
}
/** A stale result can acknowledge its exact physical slot and PCM ownership,
 * but cannot become a result for the current generation or provisional turn. */
export const transitionRecognitionSettlement = (state: RecognitionState, event: Settled): RecognitionTransition => {
  const job = findRecognitionJob(state, event.operation, event.generation)
  if (job === undefined) return unchangedRecognition(state)
  const current = currentRecognitionJob(state, job)
  const removed = { ...state, jobs: state.jobs.filter((item) => item.operation !== job.operation) }
  const released = releaseSlices(removed, job.slices)
  const result = current ? continueRecognition(released, (next) => outcome(next, job, event)) : released
  const traced =
    event.outcome.kind === "Defect"
      ? {
          ...result,
          commands: [
            { kind: "Trace" as const, cause: "recognitionDefect" as const, generation: job.generation },
            ...result.commands
          ]
        }
      : result
  return continueRecognition(traced, pumpRecognition)
}
