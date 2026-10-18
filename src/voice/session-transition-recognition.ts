import type { RecognitionInput, RecognitionCommand } from "./recognition-events.ts"
import { transitionRecognition, readyFinal } from "./recognition-transition.ts"
import type { SessionState } from "./session-state.ts"
import { pendingCount, sessionMaximumPending } from "./session-state.ts"
import { transitionSpeechFence } from "./session-transition-fence.ts"
import { emit, unchanged } from "./session-transition-result.ts"
import type { SessionTransition } from "./session-transition-result.ts"

type Projection = Exclude<RecognitionCommand, { kind: "Recognize" | "Cancel" | "ReleaseFragment" }>
const project = (state: SessionState, command: Projection): SessionTransition => {
  switch (command.kind) {
    case "Onset":
      return transitionSpeechFence(state, { kind: "Speech", generation: command.generation, fenceId: command.fenceId })
    case "Interim":
      return emit(state, { kind: "Interim", utteranceId: command.turnId, text: command.text })
    case "Error":
      return emit(
        state,
        { kind: "Error", utteranceId: command.turnId, code: command.error.code, message: command.error.message },
        command.error.reason
      )
    case "Discarded":
      return emit(state, { kind: "Discarded", utteranceId: command.turnId, reason: "Empty" })
    case "Trace":
      return { state, commands: [{ ...command, kind: "TraceRecognition" }] }
  }
}
const commandTransition = (state: SessionState, command: RecognitionCommand): SessionTransition => {
  switch (command.kind) {
    case "Recognize":
    case "Cancel":
    case "ReleaseFragment":
      return { state, commands: [{ kind: "RecognitionWork", command }] }
    default:
      return project(state, command)
  }
}
const append = (before: SessionTransition, after: SessionTransition): SessionTransition => ({
  ...before,
  ...after,
  commands: [...before.commands, ...after.commands]
})
/** Recognition is a subtransition of this writer, not another actor. */
export const composeRecognition = (before: SessionTransition, input: RecognitionInput): SessionTransition => {
  const result = transitionRecognition(before.state.recognition, input, before.state.recognitionLanguages)
  const next: SessionTransition = { ...before, state: { ...before.state, recognition: result.state } }
  return result.commands.reduce(
    (transition, command) => append(transition, commandTransition(transition.state, command)),
    next
  )
}
export const transitionRecognitionInput = (state: SessionState, input: RecognitionInput): SessionTransition =>
  input.kind === "Window" && (state.phase !== "active" || state.muted || input.generation !== state.generation)
    ? {
        state,
        commands: [{ kind: "RecognitionWork", command: { kind: "ReleaseFragment", fragmentId: input.fragmentId } }]
      }
    : composeRecognition(unchanged(state), input)

/** Quiet and complete recognition remains extendable until the acknowledged
 * fence permits an actual handoff into host-owned admission. */
export const settleRecognition = (before: SessionTransition): SessionTransition => {
  const state = before.state
  const ready = readyFinal(state.recognition)
  if (ready === null) return before
  if (pendingCount(state) > sessionMaximumPending)
    return composeRecognition(before, {
      kind: "RejectTurn",
      generation: ready.generation,
      turnId: ready.turnId,
      error: { code: "RecognitionFailed", message: "Speech admission capacity exceeded; repeat this utterance" }
    })
  const fence = state.speechFences.find(
    (item) => item.fenceId === ready.fenceId && item.generation === ready.generation
  )
  if (fence?.status === "Rejected")
    return composeRecognition(before, {
      kind: "RejectTurn",
      generation: ready.generation,
      turnId: ready.turnId,
      error: { code: "InvalidInput", message: fence.message }
    })
  if (fence?.status !== "Applied") return before
  const handed = composeRecognition(before, { kind: "Handed", generation: ready.generation, turnId: ready.turnId })
  return {
    ...handed,
    state: { ...handed.state, admitting: [...handed.state.admitting, ready.turnId] },
    commands: [
      ...handed.commands,
      {
        kind: "BeginAdmission",
        sourceSequence: fence.sequence,
        input: {
          id: ready.turnId,
          text: ready.text,
          languageSpans: ready.languageSpans,
          detectedLanguage: ready.detectedLanguage
        }
      }
    ]
  }
}
