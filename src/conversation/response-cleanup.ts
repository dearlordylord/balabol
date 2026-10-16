import type { ResponseState, ResponseAttempt, ResponseWaiter } from "./response-state.ts"
import type { ResponseCommand } from "./response-events.ts"
import { respond, type ResponseDecision } from "./response-decisions.ts"

/** Logical failure is immediate; these correlated obligations wait only for physical context/provider release. */
export const hasResponseCleanup = (state: ResponseState, attempt: bigint) =>
  state.workers.some((work) => work.attempt === attempt && (work.kind === "Context" || work.kind === "Provider"))
export const awaitResponseCleanup = (
  state: ResponseState,
  current: ResponseAttempt,
  waiter: ResponseWaiter
): ResponseDecision =>
  hasResponseCleanup(state, current.attempt)
    ? {
        state: { ...state, cleanupWaiters: [...state.cleanupWaiters, { attempt: current.attempt, current, waiter }] },
        commands: []
      }
    : { state, commands: [respond(current, waiter)] }
export const finishResponseCleanup = (state: ResponseState): ResponseDecision => {
  const ready = state.cleanupWaiters.filter((item) => !hasResponseCleanup(state, item.attempt))
  const recoveries = state.cleanupRecoveries.filter((item) => !hasResponseCleanup(state, item.attempt))
  const commands: readonly ResponseCommand[] = [
    ...ready.map((item) => respond(item.current, item.waiter)),
    ...recoveries.map((item) => ({
      kind: "RecoverMemory" as const,
      requestId: item.requestId,
      operation: item.operation,
      input: item.input
    }))
  ]
  return {
    state: {
      ...state,
      cleanupWaiters: state.cleanupWaiters.filter((item) => !ready.includes(item)),
      cleanupRecoveries: state.cleanupRecoveries.filter((item) => !recoveries.includes(item))
    },
    commands
  }
}

export const recoverAfterResponseCleanup = (
  state: ResponseState,
  command: Extract<ResponseCommand, { kind: "RecoverMemory" }>
): ResponseDecision => {
  const current = state.current
  if (current === undefined || !hasResponseCleanup(state, current.attempt)) return { state, commands: [command] }
  return {
    state: {
      ...state,
      cleanupRecoveries: [
        ...state.cleanupRecoveries,
        { attempt: current.attempt, requestId: command.requestId, operation: command.operation, input: command.input }
      ]
    },
    commands: []
  }
}
