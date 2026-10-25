import { maximumRecognitionChunks, maximumRecognitionJobs } from "./recognition-state.ts"
import type { RecognitionCommand } from "./recognition-events.ts"
import type { PcmSlice, RecognitionJob, RecognitionState } from "./recognition-state.ts"
import { failRecognitionTurn } from "./recognition-transition-reset.ts"
import { unchangedRecognition } from "./recognition-transition-result.ts"
import type { RecognitionTransition } from "./recognition-transition-result.ts"
const openJob = (state: RecognitionState) =>
  state.jobs.find(
    (job) =>
      job.streaming === "Open" &&
      job.turnId === state.turn?.id &&
      job.index === state.turn.chunks &&
      job.status !== "Cancelling"
  )
/** Open jobs borrow segment coordinates; ownership transfers only when sealed. */
export const feedStreamingRecognition = (
  state: RecognitionState,
  requestId: string,
  slices: readonly PcmSlice[]
): RecognitionTransition => {
  const turn = state.turn
  if (!state.streaming || turn === null || state.suppressed) return unchangedRecognition(state)
  const current = openJob(state)
  if (current !== undefined)
    return {
      state,
      commands: [{ kind: "AppendAudio", operation: current.operation, generation: current.generation, slices }]
    }
  if (state.jobs.length >= maximumRecognitionJobs || turn.chunks >= maximumRecognitionChunks)
    return failRecognitionTurn(state, {
      code: "RecognitionFailed",
      message: "Live recognition capacity exceeded; repeat this utterance",
      reason: "Other"
    })
  const job: RecognitionJob = {
    operation: state.nextOperation,
    status: "Reserved",
    candidate: null,
    streaming: "Open",
    turnId: turn.id,
    generation: turn.generation,
    index: turn.chunks,
    requestId,
    slices: [],
    sampleFrames: 0
  }
  const commands: readonly RecognitionCommand[] = [
    { kind: "Recognize", job },
    { kind: "AppendAudio", operation: job.operation, generation: job.generation, slices: state.segment.slices }
  ]
  return { state: { ...state, jobs: [...state.jobs, job], nextOperation: state.nextOperation + 1 }, commands }
}
export const sealStreamingRecognition = (state: RecognitionState, ended: boolean): RecognitionTransition => {
  const job = openJob(state)
  const turn = state.turn
  if (job === undefined || turn === null || state.segment.kind !== "Active") return unchangedRecognition(state)
  const segment = state.segment
  return {
    state: {
      ...state,
      jobs: state.jobs.map((item) =>
        item.operation === job.operation
          ? { ...job, streaming: "Sealed", slices: segment.slices, sampleFrames: segment.samples }
          : item
      ),
      turn: { ...turn, ended, chunks: turn.chunks + 1, ready: null },
      segment: ended
        ? { kind: "Idle", slices: [], samples: 0 }
        : { kind: "Active", slices: [], samples: 0, quiet: segment.quiet }
    },
    commands: [{ kind: "FinishAudio", operation: job.operation, generation: job.generation }]
  }
}
