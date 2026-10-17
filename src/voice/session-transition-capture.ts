import type { SessionState } from "./session-state.ts"
import type { SessionEvent } from "./session-events.ts"
import { unchanged, emit } from "./session-transition-result.ts"
import type { SessionTransition } from "./session-transition-result.ts"
type CaptureEvent = Extract<SessionEvent, { kind: "CaptureFailed" | "Frame" | "Classified" }>
const selectTrack = (state: SessionState, track: string) => {
  if (state.track === undefined || state.track === track)
    return { generation: state.generation, retiredTracks: state.retiredTracks }
  return { generation: state.generation + 1, retiredTracks: [...state.retiredTracks, state.track] }
}
const frame = (state: SessionState, event: Extract<SessionEvent, { kind: "Frame" }>): SessionTransition => {
  if (state.phase !== "active" || state.muted || state.generation !== event.generation) return unchanged(state)
  if (state.retiredTracks.includes(event.track)) return unchanged(state)
  const changed = state.track !== event.track
  const selected = selectTrack(state, event.track)
  const generation = selected.generation
  return {
    state: {
      ...state,
      track: event.track,
      retiredTracks: selected.retiredTracks,
      generation,
      classification: { operation: event.operation, generation },
      audioFramesReceived: state.audioFramesReceived + 1,
      sampleFramesReceived: state.sampleFramesReceived + event.samples
    },
    commands: changed ? [{ kind: "ResetCapture" }] : []
  }
}
const captureEnabled = (state: SessionState, generation: number) =>
  generation === state.generation && state.phase === "active" && !state.muted
const captureFailed = (
  state: SessionState,
  event: Extract<SessionEvent, { kind: "CaptureFailed" }>
): SessionTransition => {
  if (!captureEnabled(state, event.generation)) return unchanged(state)
  if (event.operation !== null && state.classification?.operation !== event.operation) return unchanged(state)
  const result = emit(
    { ...state, generation: state.generation + 1, classification: undefined },
    { kind: "Error", utteranceId: null, code: event.code, message: event.message }
  )
  return { state: result.state, commands: [{ kind: "ResetCapture" }, ...result.commands] }
}
export const transitionCapture = (state: SessionState, event: CaptureEvent): SessionTransition => {
  switch (event.kind) {
    case "CaptureFailed":
      return captureFailed(state, event)
    case "Frame":
      return frame(state, event)
    case "Classified":
      return state.classification?.operation === event.operation
        ? unchanged({ ...state, classification: undefined })
        : unchanged(state)
  }
}
