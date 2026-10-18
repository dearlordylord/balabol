import type { RecognitionJob, RecognitionState } from "./recognition-state.ts"
import type { RecognitionCommand } from "./recognition-events.ts"
import type { RecognitionTransition } from "./recognition-transition-result.ts"
const maximumConcurrent = 2
export const findRecognitionJob = (state: RecognitionState, operation: number, generation: number) =>
  state.jobs.find((job) => job.operation === operation && job.generation === generation)
export const currentRecognitionJob = (state: RecognitionState, job: RecognitionJob) =>
  job.status !== "Cancelling" && job.generation === state.turn?.generation && state.turn?.id === job.turnId
export const replaceRecognitionJob = (state: RecognitionState, job: RecognitionJob): RecognitionState => ({
  ...state,
  jobs: state.jobs.map((item) => (item.operation === job.operation ? job : item))
})
export const pumpRecognition = (state: RecognitionState): RecognitionTransition => {
  if (state.jobs.length >= maximumConcurrent) return { state, commands: [] }
  const chunk = state.queue[0]
  if (chunk === undefined) return { state, commands: [] }
  const job: RecognitionJob = { ...chunk, operation: state.nextOperation, status: "Reserved", candidate: null }
  const rest = pumpRecognition({
    ...state,
    jobs: [...state.jobs, job],
    queue: state.queue.slice(1),
    nextOperation: state.nextOperation + 1
  })
  return { state: rest.state, commands: [{ kind: "Recognize", job }, ...rest.commands] }
}
export const cancelRecognitionJobs = (state: RecognitionState): RecognitionTransition => {
  const commands: readonly RecognitionCommand[] = state.jobs
    .filter((job) => job.status !== "Cancelling")
    .map((job) => ({ kind: "Cancel", operation: job.operation }))
  return {
    state: {
      ...state,
      jobs: state.jobs.map((job): RecognitionJob => ({ ...job, status: "Cancelling", candidate: null }))
    },
    commands
  }
}
