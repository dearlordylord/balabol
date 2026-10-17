import type { SessionState, SpeechFenceState } from "./session-state.ts"
import type { SessionEvent, SessionCommand } from "./session-events.ts"
import { unchanged, emit } from "./session-transition-result.ts"
import type { SessionTransition } from "./session-transition-result.ts"
type ClosureEvent = Extract<SessionEvent, { kind: "End" | "Expire" | "Disconnected" | "Released" }>
const end = (state: SessionState, code?: string): SessionTransition => {
  if (state.phase === "closing" || state.phase === "ended") return unchanged(state)
  const fenced = {
    ...state,
    phase: "closing" as const,
    generation: state.generation + 1,
    classification: undefined,
    track: undefined,
    releasePending: ["capture", "connection", "output", "source"]
  }
  const result =
    code === undefined
      ? unchanged(fenced)
      : emit(fenced, {
          kind: "Error",
          utteranceId: null,
          code,
          message: "Media disconnected or audio queue overloaded"
        })
  return {
    state: result.state,
    commands: [
      { kind: "RetireOutput" },
      { kind: "CancelAcquisition" },
      { kind: "ResetCapture" },
      ...result.commands,
      ...fenced.releasePending.map((resource): SessionCommand => ({ kind: "Release", resource }))
    ]
  }
}
const retireSourceFences = (state: SessionState) =>
  state.speechFences.map(
    (fence): SpeechFenceState =>
      fence.status === "Pending" ? { ...fence, status: "Rejected", message: "Voice input source has closed" } : fence
  )
const released = (state: SessionState, resource: string): SessionTransition => {
  if (state.phase !== "closing" || !state.releasePending.includes(resource)) return unchanged(state)
  const pending = state.releasePending.filter((item) => item !== resource)
  const next = {
    ...state,
    releasePending: pending,
    speechFences: resource === "source" ? retireSourceFences(state) : state.speechFences
  }
  return pending.length === 0 ? emit({ ...next, phase: "ended" }, { kind: "Ended" }) : unchanged(next)
}
const expired = (state: SessionState, now: number) =>
  (state.phase === "active" || state.phase === "starting") &&
  ((!state.joined && now >= state.joinDeadlineAt) || now >= state.controlDeadlineAt)
export const transitionClosure = (state: SessionState, event: ClosureEvent): SessionTransition => {
  switch (event.kind) {
    case "End":
      return end(state)
    case "Expire":
      return expired(state, event.now) ? end(state, "SessionExpired") : unchanged(state)
    case "Disconnected":
      return end(state, event.code)
    case "Released":
      return released(state, event.resource)
  }
}
