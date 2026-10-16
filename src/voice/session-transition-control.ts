import { type SessionState, sessionControlMillis } from "./session-state.ts"
import type { SessionEvent } from "./session-events.ts"
import { unchanged, emit } from "./session-transition-result.ts"
import type { SessionTransition } from "./session-transition-result.ts"
type ControlEvent = Extract<SessionEvent, { kind: "Activated" | "Joined" | "Renew" | "Mute" }>
const mute = (state: SessionState, event: Extract<SessionEvent, { kind: "Mute" }>): SessionTransition => {
  if (state.phase !== "active") return unchanged(state)
  const result = emit(
    {
      ...state,
      muted: event.muted,
      generation: state.generation + 1,
      classification: undefined,
      provisionalFinals: [],
      controlDeadlineAt: event.now + sessionControlMillis
    },
    { kind: "Muted", muted: event.muted }
  )
  return { state: result.state, commands: [{ kind: "ResetCapture" }, ...result.commands] }
}
const joined = (state: SessionState): SessionTransition =>
  state.phase === "active" || state.phase === "starting" ? unchanged({ ...state, joined: true }) : unchanged(state)
export const transitionControl = (state: SessionState, event: ControlEvent): SessionTransition => {
  switch (event.kind) {
    case "Activated":
      return state.phase === "starting" ? unchanged({ ...state, phase: "active" }) : unchanged(state)
    case "Joined":
      return joined(state)
    case "Renew":
      return unchanged(
        state.phase === "active" ? { ...state, controlDeadlineAt: event.now + sessionControlMillis } : state
      )
    case "Mute":
      return mute(state, event)
  }
}
