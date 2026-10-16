import { failed } from "./contracts.ts"
import { pendingCount, sessionMaximumPending } from "./session-state.ts"
import type { SessionState, ProvisionalFinal } from "./session-state.ts"
import type { SessionEvent } from "./session-events.ts"
import { unchanged } from "./session-transition-result.ts"
import type { SessionTransition } from "./session-transition-result.ts"
const handoff = (state: SessionState, final: ProvisionalFinal): SessionTransition => ({
  state: {
    ...state,
    admitting: [...state.admitting, final.input.id],
    provisionalFinals: state.provisionalFinals.filter((item) => item.input.id !== final.input.id)
  },
  commands: [{ kind: "BeginAdmission", input: final.input, sourceSequence: final.sourceSequence }]
})
const knownFinal = (state: SessionState, id: string) =>
  state.admitting.includes(id) ||
  state.finals.some((item) => item.utteranceId === id) ||
  state.provisionalFinals.some((item) => item.input.id === id)
const currentFinal = (state: SessionState, event: Extract<SessionEvent, { kind: "Final" }>) =>
  event.generation === state.generation && state.phase === "active" && !state.muted
const matchingFence = (state: SessionState, event: Extract<SessionEvent, { kind: "Final" }>) => {
  const fence = state.speechFences.find((item) => item.fenceId === event.fenceId)
  if (fence === undefined || fence.status === "Rejected") return undefined
  return fence.generation === event.generation && fence.sequence === event.sourceSequence ? fence : undefined
}
/** A recognized payload waiting for its fence reserves capacity, but is not yet
 * handed to Conversation. Capture fences may discard only this provisional set. */
export const recognizeFinal = (
  state: SessionState,
  event: Extract<SessionEvent, { kind: "Final" }>
): SessionTransition => {
  if (!currentFinal(state, event)) return unchanged(state)
  if (knownFinal(state, event.input.id)) return unchanged(state)
  if (pendingCount(state) >= sessionMaximumPending)
    return {
      ...unchanged(state),
      error: failed("RecognitionFailed", "Speech admission capacity exceeded; repeat this utterance")
    }
  const fence = matchingFence(state, event)
  if (fence === undefined) return unchanged(state)
  const final: ProvisionalFinal = {
    input: event.input,
    generation: event.generation,
    fenceId: event.fenceId,
    sourceSequence: event.sourceSequence
  }
  return fence.status === "Applied"
    ? handoff(state, final)
    : unchanged({ ...state, provisionalFinals: [...state.provisionalFinals, final] })
}
export const applyFinalFence = (state: SessionState, fenceId: string): SessionTransition => {
  const final = state.provisionalFinals.find((item) => item.fenceId === fenceId)
  return final === undefined ? unchanged(state) : handoff(state, final)
}
