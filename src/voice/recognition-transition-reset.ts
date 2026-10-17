import type { RecognitionError } from "./recognition-events.ts"
import type { RecognitionSegment, RecognitionState } from "./recognition-state.ts"
import { releaseSlices } from "./recognition-transition-fragments.ts"
import { cancelRecognitionJobs } from "./recognition-transition-jobs.ts"
import { continueRecognition } from "./recognition-transition-result.ts"
import type { RecognitionTransition } from "./recognition-transition-result.ts"
const releaseCapture = (state: RecognitionState, preserveOnset = false): RecognitionTransition => {
  const segment = preserveOnset ? { state, commands: [] } : releaseSlices(state, state.segment.slices)
  const queued = state.queue.reduce(
    (step, chunk) => continueRecognition(step, (current) => releaseSlices(current, chunk.slices)),
    segment
  )
  return { state: { ...queued.state, queue: [], turn: null }, commands: queued.commands }
}
export const resetRecognition = (state: RecognitionState, generation: number): RecognitionTransition => {
  const result = continueRecognition(releaseCapture(state), cancelRecognitionJobs)
  return {
    state: { ...result.state, generation, segment: { kind: "Idle", slices: [], samples: 0 }, suppressed: false },
    commands: result.commands
  }
}
export const failRecognitionTurn = (state: RecognitionState, error: RecognitionError): RecognitionTransition => {
  const turn = state.turn
  if (turn === null) return { state, commands: [] }
  const quiet = state.segment.kind === "Active" ? state.segment.quiet : 0
  const preserveOnset = turn.ended && state.segment.kind === "Idle"
  const result = continueRecognition(releaseCapture(state, preserveOnset), cancelRecognitionJobs)
  const endedSegment: RecognitionSegment = preserveOnset ? state.segment : { kind: "Idle", slices: [], samples: 0 }
  return {
    state: {
      ...result.state,
      suppressed: !turn.ended,
      segment: turn.ended ? endedSegment : { kind: "Active", slices: [], samples: 0, quiet }
    },
    commands: [...result.commands, { kind: "Error", turnId: turn.id, generation: turn.generation, error }]
  }
}
