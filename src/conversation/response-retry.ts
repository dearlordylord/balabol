import { recoverAfterResponseCleanup } from "./response-cleanup.ts"
import type { Receipt } from "../memory/index.ts"
import type { ResponseState } from "./response-state.ts"
import { replyProjection } from "./response-state.ts"
import type { ResponseEvent } from "./response-events.ts"
import { unchangedResponse, retryTerminal, type ResponseDecision } from "./response-decisions.ts"
import { pendingChecked } from "./response-settlement.ts"
import { beginResponse } from "./response-generation.ts"
import { ReplyBusy, ReplyNotFound } from "./contracts.ts"
import { restoredReply } from "./reply-projection.ts"

export const retryResponse = (
  state: ResponseState,
  event: Extract<ResponseEvent, { kind: "Retry" }>
): ResponseDecision => {
  const operation = state.nextToken
  return {
    state: {
      ...state,
      nextToken: operation + 1n,
      retryChecks: [
        ...state.retryChecks,
        {
          requestId: event.requestId,
          expectedAttempt: state.current?.attempt,
          operation,
          inputDeliveryId: event.inputDeliveryId,
          responseId: event.responseId,
          issuedRevision: state.revision
        }
      ]
    },
    commands: [{ kind: "ReadRetry", requestId: event.requestId, operation, inputDeliveryId: event.inputDeliveryId }]
  }
}
type RetryCheck = ResponseState["retryChecks"][number]
const joinExistingRetry = (state: ResponseState, check: RetryCheck): ResponseDecision | undefined => {
  const current = state.current
  if (current?.input.deliveryId !== check.inputDeliveryId) return undefined
  if (current.work.kind === "Settling")
    return retryTerminal(state, {
      ...current,
      waiters: [...current.waiters, { requestId: check.requestId, result: "Reply" }]
    })
  if (current.work.kind === "Failed") return undefined
  return {
    state,
    commands: [
      { kind: "Resolve", requestId: check.requestId, result: { kind: "Reply", reply: replyProjection(current) } }
    ]
  }
}
const failedRetryCheck = (state: ResponseState, check: RetryCheck, message: string): ResponseDecision => ({
  state,
  commands: [{ kind: "Reject", requestId: check.requestId, error: new ReplyBusy({ message }) }]
})
const concurrentRecovery = (state: ResponseState, check: RetryCheck): ResponseDecision | undefined => {
  if (state.current === undefined) return undefined
  if (state.current.attempt === check.expectedAttempt && state.current.work.kind === "Failed") return undefined
  if (state.current.input.deliveryId !== check.inputDeliveryId)
    return failedRetryCheck(state, check, "Response authority changed during retry recovery")
  return {
    state,
    commands: [
      { kind: "Resolve", requestId: check.requestId, result: { kind: "Reply", reply: replyProjection(state.current) } }
    ]
  }
}
const latestRetryInput = (state: ResponseState, check: RetryCheck, input: Receipt | undefined): input is Receipt =>
  check.issuedRevision === state.revision && input?.deliveryId === check.inputDeliveryId
export const retryChecked = (
  state: ResponseState,
  event: Extract<ResponseEvent, { kind: "RetryChecked" }>
): ResponseDecision => {
  const check = state.retryChecks.find(
    (item) => item.operation === event.operation && item.requestId === event.requestId
  )
  if (check === undefined) return unchangedResponse(state)
  const clean = { ...state, retryChecks: state.retryChecks.filter((item) => item !== check) }
  if (!latestRetryInput(state, check, event.input))
    return {
      state: clean,
      commands: [
        {
          kind: "Reject",
          requestId: event.requestId,
          error: new ReplyBusy({ message: "Only the latest accepted input can be retried" })
        }
      ]
    }
  if (event.receipt !== undefined)
    return {
      state: clean,
      commands: [
        {
          kind: "Resolve",
          requestId: event.requestId,
          result: { kind: "Reply", reply: restoredReply(event.receipt, check.inputDeliveryId) }
        }
      ]
    }
  const existing = joinExistingRetry(clean, check)
  if (existing !== undefined) return existing
  if (event.pending !== undefined)
    return pendingChecked(
      { ...clean, current: undefined },
      {
        kind: "PendingChecked",
        requestId: event.requestId,
        payload: event.pending,
        input: event.input,
        result: "Reply"
      }
    )
  return recoverAfterResponseCleanup(state, {
    kind: "RecoverMemory",
    requestId: event.requestId,
    operation: event.operation,
    input: event.input
  })
}
export const retryRecovered = (
  state: ResponseState,
  event: Extract<ResponseEvent, { kind: "RetryRecovered" }>,
  languages: readonly string[],
  attachmentMillis: number
): ResponseDecision => {
  const check = state.retryChecks.find(
    (item) => item.operation === event.operation && item.requestId === event.requestId
  )
  if (check === undefined) return unchangedResponse(state)
  const clean = { ...state, retryChecks: state.retryChecks.filter((item) => item !== check) }
  if (check.issuedRevision !== state.revision)
    return {
      state: clean,
      commands: [
        {
          kind: "Reject",
          requestId: event.requestId,
          error: new ReplyBusy({ message: "A newer input superseded this retry" })
        }
      ]
    }
  if (event.input.deliveryId !== check.inputDeliveryId)
    return {
      state: clean,
      commands: [
        { kind: "Reject", requestId: event.requestId, error: new ReplyNotFound({ message: "Unknown retry input" }) }
      ]
    }
  const concurrent = concurrentRecovery(clean, check)
  if (concurrent !== undefined) return concurrent
  const started = beginResponse(
    clean,
    {
      kind: "Start",
      requestId: event.requestId,
      input: event.input,
      responseId: check.responseId,
      issuedRevision: check.issuedRevision,
      granted: true,
      superseded: false
    },
    languages,
    attachmentMillis
  )
  // Retry returns the current response projection once start preparation has completed.
  return { state: started.state, commands: started.commands }
}
