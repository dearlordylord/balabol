import { awaitResponseCleanup, finishResponseCleanup } from "./response-cleanup.ts"
import terminalCore from "./response-terminal-core/index.ts"
import type { Receipt, DeliveryPayload } from "../memory/index.ts"
import { samePayload } from "../memory/index.ts"
import { StorageUnavailable } from "./contracts.ts"
import type { ResponseState, ResponseAttempt } from "./response-state.ts"
import { sameTarget, ticketMatches } from "./response-state.ts"
import type { ResponseEvent, ResponseCommand } from "./response-events.ts"
import {
  unchangedResponse,
  updateResponse,
  done,
  finishWaiters,
  updateDelivery,
  selectTerminal,
  retryTerminal,
  failResponse,
  persistIfReady,
  type ResponseDecision
} from "./response-decisions.ts"

type InterruptEvent = Extract<ResponseEvent, { kind: "Admit" | "Interrupt" }>
const joinFailedSettlement = (
  state: ResponseState,
  current: ResponseAttempt,
  event: InterruptEvent
): ResponseDecision | undefined => {
  if (
    current.work.kind === "Settling" &&
    current.work.write === "Failed" &&
    event.joinRevision === current.work.selectedRevision
  )
    return {
      state,
      commands: [
        {
          kind: "Reject",
          requestId: event.requestId,
          error: new StorageUnavailable({
            message: current.work.failure?.message ?? "Terminal persistence unavailable"
          })
        }
      ]
    }
  return undefined
}
const interruptCurrent = (state: ResponseState, current: ResponseAttempt, event: InterruptEvent): ResponseDecision => {
  const result = event.kind === "Admit" ? "Done" : "Reply"
  if (current.work.kind === "Failed")
    return awaitResponseCleanup(state, current, { requestId: event.requestId, result })
  if (current.work.kind === "Terminal")
    return {
      state,
      commands: finishWaiters({
        ...current,
        startRequest: undefined,
        waiters: [{ requestId: event.requestId, result }]
      })
    }
  const failedJoin = joinFailedSettlement(state, current, event)
  if (failedJoin !== undefined) return failedJoin
  const waiting = { ...current, waiters: [...current.waiters, { requestId: event.requestId, result } as const] }
  return current.work.kind === "Settling"
    ? retryTerminal(state, waiting)
    : selectTerminal(state, waiting, "Interrupted", event.reason)
}
export const interruptResponse = (state: ResponseState, event: InterruptEvent): ResponseDecision => {
  const current = state.current
  if (current === undefined)
    return {
      state,
      commands: [
        event.kind === "Admit"
          ? { kind: "ReadPending", requestId: event.requestId }
          : { kind: "Resolve", requestId: event.requestId, result: { kind: "Reply", reply: null } }
      ]
    }
  if (event.kind === "Interrupt" && !sameTarget(current, event.target))
    return {
      state,
      commands: [{ kind: "Resolve", requestId: event.requestId, result: { kind: "Reply", reply: null } }]
    }
  return interruptCurrent(state, current, event)
}
const publishStored = (
  state: ResponseState,
  stored: ResponseAttempt,
  receipt: Receipt,
  commands: readonly ResponseCommand[]
): ResponseDecision => {
  if (stored.ticket === undefined || receipt.outcome !== "completed") return updateResponse(state, stored, commands)
  const update = {
    kind: "Delivered" as const,
    registrationId: stored.ticket.registrationId,
    ticket: stored.ticket,
    sequence: (state.registration?.update.sequence ?? 0) + 1
  }
  return {
    state: updateDelivery({ ...state, current: stored }, update),
    commands: [{ kind: "PublishDelivery", update }, ...commands]
  }
}
type SettlingResponse = ResponseAttempt & { readonly work: Extract<ResponseAttempt["work"], { kind: "Settling" }> }
type TerminalNotification = Extract<ResponseEvent, { kind: "TerminalStored" | "TerminalFailed" }>
const matchesTerminalIntent = (
  current: ResponseAttempt | undefined,
  event: TerminalNotification
): current is SettlingResponse =>
  current?.attempt === event.attempt &&
  current.work.kind === "Settling" &&
  current.work.terminal.intent.operation === event.operation
const matchesPersistenceInvocation = (
  current: ResponseAttempt | undefined,
  event: TerminalNotification
): current is SettlingResponse =>
  matchesTerminalIntent(current, event) &&
  current.work.terminal.$ === "Persisting" &&
  current.work.terminal.invocation === event.invocation
export const terminalStored = (
  state: ResponseState,
  event: Extract<ResponseEvent, { kind: "TerminalStored" }>
): ResponseDecision => {
  const current = state.current
  if (!matchesTerminalIntent(current, event)) return unchangedResponse(state)
  if (!samePayload(event.payload, current.work.payload) || !samePayload(event.receipt, current.work.payload))
    return terminalFailed(state, {
      ...event,
      kind: "TerminalFailed",
      error: new StorageUnavailable({ message: "Terminal receipt does not match the selected immutable intent" })
    })
  const decision = terminalCore.transition(current.work.terminal, {
    $: "StoredAck",
    attempt: event.attempt,
    intent: current.work.terminal.intent
  })
  if (decision.state.$ !== "Stored") return unchangedResponse(state)
  const stored = {
    ...current,
    sequence: current.sequence + 1,
    work: { kind: "Terminal" as const, terminal: decision.state, receipt: structuredClone(event.receipt) },
    waiters: [],
    startRequest: undefined
  }
  const commands = finishWaiters({ ...stored, waiters: current.waiters, startRequest: current.startRequest })
  return publishStored(state, stored, event.receipt, commands)
}

const failedSettlementWaiters = (current: ResponseAttempt, error: StorageUnavailable): readonly ResponseCommand[] => [
  ...current.waiters.map(
    (waiter): ResponseCommand =>
      waiter.failure === "Ignore" ? done(waiter.requestId) : { kind: "Reject", requestId: waiter.requestId, error }
  ),
  ...(current.startRequest === undefined ? [] : [{ kind: "Reject" as const, requestId: current.startRequest, error }])
]
export const terminalFailed = (
  state: ResponseState,
  event: Extract<ResponseEvent, { kind: "TerminalFailed" }>
): ResponseDecision => {
  const current = state.current
  if (!matchesPersistenceInvocation(current, event)) return unchangedResponse(state)
  const decision = terminalCore.transition(current.work.terminal, {
    $: "StorageFailed",
    attempt: event.attempt,
    operation: event.operation,
    invocation: event.invocation
  })
  if (decision.state.$ !== "Retryable") return unchangedResponse(state)
  return updateResponse(
    state,
    {
      ...current,
      sequence: current.sequence + 1,
      startRequest: undefined,
      waiters: [],
      work: {
        ...current.work,
        terminal: decision.state,
        write: "Failed",
        failure: { code: "StorageUnavailable", message: event.error.message }
      }
    },
    failedSettlementWaiters(current, event.error)
  )
}
export const workFinished = (
  state: ResponseState,
  event: Extract<ResponseEvent, { kind: "WorkFinished" }>
): ResponseDecision => {
  const released = {
    ...state,
    workers: state.workers.filter((work) => work.attempt !== event.attempt || work.operation !== event.operation)
  }
  const cleanup = finishResponseCleanup(released)
  const persistence = persistIfReady(cleanup.state)
  return { state: persistence.state, commands: [...cleanup.commands, ...persistence.commands] }
}
export const workFailed = (
  state: ResponseState,
  event: Extract<ResponseEvent, { kind: "WorkFailed" }>
): ResponseDecision => {
  const current = state.current
  if (
    current?.attempt !== event.attempt ||
    !state.workers.some(
      (work) => work.operation === event.operation && work.attempt === event.attempt && work.status === "Running"
    ) ||
    current.work.kind === "Settling" ||
    current.work.kind === "Terminal" ||
    current.work.kind === "Failed"
  )
    return unchangedResponse(state)
  return failResponse(state, current, event.error)
}
export const settleDelivery = (
  state: ResponseState,
  event: Extract<ResponseEvent, { kind: "Settle" }>
): ResponseDecision => {
  const current = state.current
  if (
    current === undefined ||
    current.authorization !== "Active" ||
    !ticketMatches(current.ticket, event.settlement) ||
    (event.settlement.outcome === "Completed" && current.work.kind !== "AwaitingDelivery")
  )
    return {
      state,
      commands: [{ kind: "Resolve", requestId: event.requestId, result: { kind: "Reply", reply: null } }]
    }
  return selectTerminal(
    state,
    { ...current, waiters: [...current.waiters, { requestId: event.requestId, result: "Reply" }] },
    event.settlement.outcome === "Completed" ? "Completed" : "Interrupted",
    event.settlement.outcome === "Failed" ? "Failed" : "Interrupted"
  )
}

const hydratePending = (
  state: ResponseState,
  event: Extract<ResponseEvent, { kind: "PendingChecked" }>,
  input: Receipt,
  selectedPayload: DeliveryPayload
): ResponseDecision => {
  const payload = structuredClone(selectedPayload)
  const attempt = state.nextToken
  const operation = attempt + 1n
  const invocation = operation + 1n
  const selected = terminalCore.transition(terminalCore.initialize(attempt), {
    $: "Select",
    attempt,
    intent: {
      $: "Intent",
      operation,
      payload: operation,
      outcome: { $: payload.outcome === "completed" ? "Completed" : "Interrupted" }
    },
    invocation
  })
  if (selected.state.$ !== "Persisting") throw new Error("Cold response intent did not reserve persistence")
  return persistIfReady({
    ...state,
    nextToken: invocation + 1n,
    current: {
      attempt,
      input,
      responseId: payload.deliveryId,
      responseLanguage: payload.responseLanguage ?? "en",
      issuedRevision: state.revision,
      authorization: "Revoked",
      sequence: 0,
      text: payload.text,
      languageSpans: payload.languageSpans ?? [],
      observer: undefined,
      ticket: undefined,
      startRequest: undefined,
      waiters: [{ requestId: event.requestId, result: event.result ?? "Done" }],
      work: {
        kind: "Settling",
        selectedRevision: state.revision,
        terminal: selected.state,
        payload,
        write: "WaitingForCleanup",
        failure: undefined,
        projection: "Streaming"
      }
    }
  })
}

export const pendingChecked = (
  state: ResponseState,
  event: Extract<ResponseEvent, { kind: "PendingChecked" }>
): ResponseDecision => {
  if (event.payload === undefined) return { state, commands: [done(event.requestId)] }
  if (state.current !== undefined)
    return interruptResponse(state, { kind: "Admit", requestId: event.requestId, reason: "Interrupted" })
  if (event.input === undefined) throw new Error("Durable response intent lost its accepted input")
  return hydratePending(state, event, event.input, event.payload)
}
