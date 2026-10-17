import type { RecognitionInput } from "./recognition-events.ts"
import type { RecognitionState, RecognitionJob, RecognitionFinal } from "./recognition-state.ts"
import { findRecognitionJob, currentRecognitionJob, replaceRecognitionJob } from "./recognition-transition-jobs.ts"
import { failRecognitionTurn } from "./recognition-transition-reset.ts"
import { unchangedRecognition } from "./recognition-transition-result.ts"
import type { RecognitionTransition } from "./recognition-transition-result.ts"
type PacketInput = Extract<RecognitionInput, { kind: "JobStarted" | "Packet" | "Invalid" }>
const supportedFinal = (final: RecognitionFinal, languages: readonly string[]) =>
  final.spans.every((span) => languages.includes(span.language)) &&
  (final.detectedLanguage == null || languages.includes(final.detectedLanguage))
const packet = (
  state: RecognitionState,
  job: RecognitionJob,
  event: Extract<RecognitionInput, { kind: "Packet" }>,
  languages: readonly string[]
): RecognitionTransition => {
  if (job.status !== "Running" || event.event.utteranceId !== job.requestId || job.candidate !== null)
    return unchangedRecognition(state)
  if (event.event.kind === "Interim")
    return {
      state,
      commands: [{ kind: "Interim", turnId: job.turnId, generation: job.generation, text: event.event.text }]
    }
  if (!supportedFinal(event.event, languages))
    return failRecognitionTurn(state, {
      code: "InvalidRecognition",
      message: "Detected language is outside the configured set"
    })
  return unchangedRecognition(replaceRecognitionJob(state, { ...job, candidate: event.event }))
}
export const transitionRecognitionPacket = (
  state: RecognitionState,
  event: PacketInput,
  languages: readonly string[]
): RecognitionTransition => {
  const job = findRecognitionJob(state, event.operation, event.generation)
  if (job === undefined || !currentRecognitionJob(state, job)) return unchangedRecognition(state)
  switch (event.kind) {
    case "JobStarted":
      return job.status === "Reserved"
        ? {
            state: replaceRecognitionJob(state, { ...job, status: "Running" }),
            commands: [{ kind: "Trace", cause: "recognitionStarted", sampleFrames: job.sampleFrames }]
          }
        : unchangedRecognition(state)
    case "Packet":
      return packet(state, job, event, languages)
    case "Invalid":
      return failRecognitionTurn(state, event.error)
  }
}
