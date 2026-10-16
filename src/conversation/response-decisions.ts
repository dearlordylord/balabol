import terminalCore from "./response-terminal-core/index.ts"
import type {
  ResponseState,
  ResponseAttempt,
  ResponseWaiter,
  ReplyFailure,
  OwnedResponseWork
} from "./response-state.ts"
import { replyProjection } from "./response-state.ts"
import type { ResponseCommand } from "./response-events.ts"
import type { ResponseInvalidation, ReplyDeliveryUpdate } from "./delivery.ts"
import type { DeliveryPayload } from "../memory/index.ts"

export type ResponseDecision = { readonly state: ResponseState; readonly commands: readonly ResponseCommand[] }
export const unchangedResponse = (state: ResponseState): ResponseDecision => ({ state, commands: [] })
export const updateResponse = (
  state: ResponseState,
  current: ResponseAttempt,
  commands: readonly ResponseCommand[] = []
): ResponseDecision => ({ state: { ...state, current }, commands })
export const done = (requestId: string): ResponseCommand => ({ kind: "Resolve", requestId, result: { kind: "Done" } })
export const respond = (response: ResponseAttempt, waiter: ResponseWaiter): ResponseCommand => ({
  kind: "Resolve",
  requestId: waiter.requestId,
  result: waiter.result === "Done" ? { kind: "Done" } : { kind: "Reply", reply: replyProjection(response) }
})
export const finishWaiters = (response: ResponseAttempt): readonly ResponseCommand[] => [
  ...response.waiters.map((waiter) => respond(response, waiter)),
  ...(response.startRequest === undefined ? [] : [done(response.startRequest)])
]
export const updateDelivery = (state: ResponseState, update: ReplyDeliveryUpdate): ResponseState =>
  state.registration?.registrationId === update.registrationId
    ? { ...state, registration: { ...state.registration, update } }
    : state
export const revokeDelivery = (
  state: ResponseState,
  response: ResponseAttempt,
  reason: ResponseInvalidation["reason"]
): ResponseDecision => {
  if (response.ticket === undefined) return unchangedResponse(state)
  const ticket = response.ticket
  const update: ReplyDeliveryUpdate = {
    kind: "Invalidated",
    registrationId: ticket.registrationId,
    sequence: (state.registration?.update.sequence ?? 0) + 1,
    ticket,
    reason
  }
  return {
    state: updateDelivery(state, update),
    commands: [
      { kind: "CloseTicket", ticket },
      { kind: "PublishDelivery", update }
    ]
  }
}
const cancellableWork = (state: ResponseState, attempt: bigint) =>
  state.workers.filter((work) => work.attempt === attempt && work.status === "Running")
export const cancelWorkers = (state: ResponseState, response: ResponseAttempt): ResponseDecision => {
  const workers = cancellableWork(state, response.attempt)
  return {
    state: {
      ...state,
      workers: state.workers.map((work) => (workers.includes(work) ? { ...work, status: "Cancelling" } : work))
    },
    commands: workers.map((work) => ({ kind: "CancelWork", work }))
  }
}
const blocksWrite = (work: OwnedResponseWork) => work.kind === "Context" || work.kind === "Provider"
export const persistIfReady = (state: ResponseState): ResponseDecision => {
  const current = state.current
  if (current?.work.kind !== "Settling" || current.work.terminal.$ !== "Persisting") return unchangedResponse(state)
  if (current.work.write !== "WaitingForCleanup") return unchangedResponse(state)
  if (state.workers.some((work) => work.attempt === current.attempt && blocksWrite(work)))
    return unchangedResponse(state)
  const terminal = current.work.terminal
  return updateResponse(state, { ...current, work: { ...current.work, write: "Executing" } }, [
    {
      kind: "PersistTerminal",
      attempt: current.attempt,
      operation: terminal.intent.operation,
      invocation: terminal.invocation,
      payload: current.work.payload
    }
  ])
}
const settlingProjection = (response: ResponseAttempt) => {
  if (replyProjection(response).state === "Delivering") return "Delivering"
  return response.text.length === 0 ? "Waiting" : "Streaming"
}
const fenceSelectedDelivery = (
  state: ResponseState,
  response: ResponseAttempt,
  outcome: "Completed" | "Interrupted",
  reason: ResponseInvalidation["reason"]
): ResponseDecision => {
  if (outcome === "Interrupted") return revokeDelivery(state, response, reason)
  return { state, commands: response.ticket === undefined ? [] : [{ kind: "CloseTicket", ticket: response.ticket }] }
}
export const selectTerminal = (
  state: ResponseState,
  response: ResponseAttempt,
  outcome: "Completed" | "Interrupted",
  reason: ResponseInvalidation["reason"] = "Interrupted"
): ResponseDecision => {
  if (response.work.kind === "Settling" || response.work.kind === "Terminal") return updateResponse(state, response)
  const operation = state.nextToken
  const payload: DeliveryPayload = {
    deliveryId: response.responseId,
    responseId: response.responseId,
    inputDeliveryId: response.input.deliveryId,
    role: "assistant",
    outcome: outcome === "Completed" ? "completed" : "interrupted",
    text: response.text,
    responseLanguage: response.responseLanguage,
    languageSpans: structuredClone(response.languageSpans)
  }
  const decision = terminalCore.transition(terminalCore.initialize(response.attempt), {
    $: "Select",
    attempt: response.attempt,
    intent: { $: "Intent", operation, payload: operation, outcome: { $: outcome } },
    invocation: operation + 1n
  })
  if (decision.state.$ !== "Persisting") throw new Error("Terminal selection did not reserve persistence")
  const current: ResponseAttempt = {
    ...response,
    authorization: "Revoked",
    sequence: response.sequence + 1,
    work: {
      kind: "Settling",
      selectedRevision: state.revision,
      terminal: decision.state,
      payload,
      write: "WaitingForCleanup",
      failure: undefined,
      projection: settlingProjection(response)
    }
  }
  const selected = { ...state, current, nextToken: operation + 2n }
  const revoked = fenceSelectedDelivery(selected, current, outcome, reason)
  const cancelled = cancelWorkers(revoked.state, current)
  const persistence = persistIfReady(cancelled.state)
  return { state: persistence.state, commands: [...revoked.commands, ...cancelled.commands, ...persistence.commands] }
}
export const retryTerminal = (state: ResponseState, response: ResponseAttempt): ResponseDecision => {
  if (response.work.kind !== "Settling") return updateResponse(state, response)
  if (response.work.terminal.$ !== "Retryable") return updateResponse(state, response)
  const invocation = state.nextToken
  const decision = terminalCore.transition(response.work.terminal, {
    $: "RetryPersistence",
    attempt: response.attempt,
    operation: response.work.terminal.intent.operation,
    invocation
  })
  if (decision.state.$ !== "Persisting") throw new Error("Terminal retry did not retain its obligation")
  return persistIfReady({
    ...state,
    nextToken: invocation + 1n,
    current: {
      ...response,
      work: { ...response.work, terminal: decision.state, write: "WaitingForCleanup", failure: undefined }
    }
  })
}
export const failResponse = (
  state: ResponseState,
  response: ResponseAttempt,
  error: ReplyFailure
): ResponseDecision => {
  const current: ResponseAttempt = {
    ...response,
    authorization: "Revoked",
    sequence: response.sequence + 1,
    work: { kind: "Failed", error },
    startRequest: undefined,
    waiters: []
  }
  const revoked = revokeDelivery({ ...state, current }, current, "Failed")
  const cancelled = cancelWorkers(revoked.state, current)
  return {
    state: cancelled.state,
    commands: [
      ...revoked.commands,
      ...cancelled.commands,
      ...finishWaiters({ ...current, startRequest: response.startRequest, waiters: response.waiters })
    ]
  }
}
