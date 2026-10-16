import { applyFinalFence } from "./session-transition-final.ts"
import type { SessionEvent, SessionCommand } from "./session-events.ts"
import type { SessionState, SpeechFenceState } from "./session-state.ts"
import { unchanged, emit } from "./session-transition-result.ts"
import type { SessionTransition } from "./session-transition-result.ts"
type FenceEvent = Extract<SessionEvent, { kind: "Speech" | "FenceApplied" | "FenceRejected" }>
const retainedTerminalFences = 2
const retainFence = (state: SessionState, fence: SpeechFenceState) => {
  const others = state.speechFences.filter((item) => item.fenceId !== fence.fenceId)
  const pending = others.filter((item) => item.status === "Pending")
  const terminal = others.filter((item) => item.status !== "Pending").slice(-retainedTerminalFences)
  return [...pending, ...terminal, fence]
}
const speech = (state: SessionState, event: Extract<FenceEvent, { kind: "Speech" }>): SessionTransition => {
  if (event.generation !== state.generation || state.phase !== "active" || state.muted) return unchanged(state)
  if (state.speechFences.some((item) => item.fenceId === event.fenceId)) return unchanged(state)
  const sequence = state.speechRevision + 1
  return {
    state: {
      ...state,
      speechRevision: sequence,
      speechFences: retainFence(state, {
        fenceId: event.fenceId,
        generation: event.generation,
        sequence,
        status: "Pending"
      })
    },
    commands: [
      { kind: "FenceSpeech", sequence, fenceId: event.fenceId, generation: event.generation, suppress: state.admitting }
    ]
  }
}
const matchesPending = (
  fence: SpeechFenceState | undefined,
  event: Exclude<FenceEvent, { kind: "Speech" }>
): fence is Extract<SpeechFenceState, { status: "Pending" }> =>
  fence?.status === "Pending" && fence.generation === event.generation && fence.sequence === event.sequence
const rejection = (state: SessionState, event: Exclude<FenceEvent, { kind: "Speech" }>): SessionTransition => {
  if (event.kind !== "FenceRejected") return unchanged(state)
  const dropped = {
    ...state,
    provisionalFinals: state.provisionalFinals.filter((item) => item.fenceId !== event.fenceId)
  }
  if (event.generation !== state.generation || state.phase !== "active") return unchanged(dropped)
  if (event.sequence !== state.speechRevision) return unchanged(dropped)
  return emit(
    { ...dropped, generation: state.generation + 1, classification: undefined, provisionalFinals: [] },
    { kind: "Error", utteranceId: null, code: "InvalidInput", message: event.message }
  )
}
const settle = (state: SessionState, event: Exclude<FenceEvent, { kind: "Speech" }>): SessionTransition => {
  const fence = state.speechFences.find((item) => item.fenceId === event.fenceId)
  if (!matchesPending(fence, event)) return unchanged(state)
  const settled: SpeechFenceState =
    event.kind === "FenceApplied"
      ? { ...fence, status: "Applied", revision: event.revision }
      : { ...fence, status: "Rejected", message: event.message }
  const next = { ...state, speechFences: retainFence(state, settled) }
  const result = event.kind === "FenceApplied" ? applyFinalFence(next, event.fenceId) : rejection(next, event)
  const reset: readonly SessionCommand[] =
    result.state.generation !== state.generation ? [{ kind: "ResetCapture" }] : []
  return { state: result.state, commands: [...reset, ...result.commands] }
}
export const transitionSpeechFence = (state: SessionState, event: FenceEvent): SessionTransition =>
  event.kind === "Speech" ? speech(state, event) : settle(state, event)
