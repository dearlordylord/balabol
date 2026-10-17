import type { SessionState } from "./session-state.ts"
import type { SessionEvent, SessionCommand } from "./session-events.ts"
import type { SessionTransition } from "./session-transition-result.ts"
import { unchanged } from "./session-transition-result.ts"
import { transitionClosure } from "./session-transition-closure.ts"
type ExpiryEvent = Extract<SessionEvent, { kind: "InitializeExpiry" | "ExpiryDue" }>
const deadline = (state: SessionState): number | null => {
  if (state.phase !== "starting" && state.phase !== "active") return null
  return state.joined ? state.controlDeadlineAt : Math.min(state.joinDeadlineAt, state.controlDeadlineAt)
}
/** Deadline selection belongs to this writer. Resources only schedule its exact
 * token; renew/join can supersede a queued wake without trusting cancellation. */
export const reconcileSessionExpiry = (result: SessionTransition): SessionTransition => {
  const state = result.state
  const deadlineAt = deadline(state)
  if (state.expiryTimer?.deadlineAt === deadlineAt) return result
  if (state.expiryTimer === null && deadlineAt === null) return result
  const cancelled: readonly SessionCommand[] =
    state.expiryTimer === null ? [] : [{ kind: "CancelExpiry", operation: state.expiryTimer.operation }]
  if (deadlineAt === null)
    return { ...result, state: { ...state, expiryTimer: null }, commands: [...result.commands, ...cancelled] }
  const operation = state.nextExpiryOperation
  return {
    ...result,
    state: { ...state, expiryTimer: { operation, deadlineAt }, nextExpiryOperation: operation + 1 },
    commands: [...result.commands, ...cancelled, { kind: "ScheduleExpiry", operation, deadlineAt }]
  }
}
export const transitionSessionExpiry = (state: SessionState, event: ExpiryEvent): SessionTransition => {
  if (event.kind === "InitializeExpiry") return unchanged(state)
  const timer = state.expiryTimer
  if (timer === null || event.operation !== timer.operation || event.deadlineAt !== timer.deadlineAt)
    return unchanged(state)
  // A wake acknowledges only its own timer. An early clock wake is rearmed by
  // reconciliation, while a genuine deadline uses the existing expiry decision.
  return transitionClosure({ ...state, expiryTimer: null }, { kind: "Expire", now: event.now })
}
