import { StorageUnavailable } from "./contracts.ts"
import { Schema } from "effect"
import { LanguageSpans, validLanguageSpans } from "../language/index.ts"
import { maximumReplyLength, waitingReply } from "./reply-projection.ts"
import type { ResponseState, ResponseAttempt } from "./response-state.ts"
import type { ResponseEvent } from "./response-events.ts"
import {
  unchangedResponse,
  updateResponse,
  done,
  failResponse,
  selectTerminal,
  retryTerminal,
  updateDelivery,
  type ResponseDecision
} from "./response-decisions.ts"

export const beginContext = (
  state: ResponseState,
  response: ResponseAttempt,
  attachmentMillis: number
): ResponseDecision => {
  const operation = state.nextToken
  const timer = operation + 1n
  const current: ResponseAttempt = {
    ...response,
    startRequest: undefined,
    work: { kind: "PreparingContext", operation }
  }
  return {
    state: {
      ...state,
      current,
      nextToken: timer + 1n,
      workers: [
        ...state.workers,
        { operation, attempt: current.attempt, kind: "Context", status: "Running" },
        { operation: timer, attempt: current.attempt, kind: "AttachmentTimer", status: "Running" }
      ]
    },
    commands: [
      { kind: "PrepareContext", attempt: current.attempt, operation, input: current.input },
      { kind: "ScheduleAttachment", attempt: current.attempt, operation: timer, millis: attachmentMillis },
      ...(response.startRequest === undefined ? [] : [done(response.startRequest)])
    ]
  }
}
const blocksSupersededStart = (current: ResponseAttempt, inputDeliveryId: string) =>
  current.input.deliveryId !== inputDeliveryId && current.work.kind !== "Terminal" && current.work.kind !== "Failed"
const supersededStart = (
  state: ResponseState,
  event: Extract<ResponseEvent, { kind: "Start" }>
): ResponseDecision | undefined => {
  if (!event.superseded) return undefined
  const current = state.current
  if (current === undefined) return undefined
  if (blocksSupersededStart(current, event.input.deliveryId))
    return {
      state,
      commands: [
        {
          kind: "Reject",
          requestId: event.requestId,
          error: new StorageUnavailable({ message: "A newer response owns execution; retain superseded settlement" })
        }
      ]
    }
  if (current.input.deliveryId !== event.input.deliveryId) return undefined
  if (current.work.kind === "Terminal") return { state, commands: [done(event.requestId)] }
  if (current.work.kind === "Settling")
    return retryTerminal(state, {
      ...current,
      waiters: [...current.waiters, { requestId: event.requestId, result: "Done" }]
    })
  return undefined
}
export const beginResponse = (
  initialState: ResponseState,
  event: Extract<ResponseEvent, { kind: "Start" }>,
  languages: readonly string[],
  attachmentMillis: number
): ResponseDecision => {
  const state = initialState
  const superseded = supersededStart(state, event)
  if (superseded !== undefined) return superseded
  const initialized = waitingReply(event.input, event.responseId, languages)
  const attempt = state.nextToken
  const current: ResponseAttempt = {
    attempt,
    input: structuredClone(event.input),
    responseId: event.responseId,
    responseLanguage: initialized.base.responseLanguage,
    issuedRevision: event.issuedRevision,
    authorization: "Active",
    sequence: 0,
    text: "",
    languageSpans: [],
    observer: undefined,
    ticket: undefined,
    startRequest: event.requestId,
    waiters: [],
    work: { kind: "Reserved" }
  }
  const next = { ...state, current, nextToken: attempt + 1n }
  if (event.superseded || !event.granted || event.issuedRevision !== state.revision)
    return selectTerminal(next, current, "Interrupted")
  if (state.registration === undefined) return beginContext(next, current, attachmentMillis)
  const operation = next.nextToken
  return {
    state: {
      ...next,
      nextToken: operation + 1n,
      current: {
        ...current,
        work: { kind: "PreparingDelivery", operation, registrationId: state.registration.registrationId }
      },
      workers: [...state.workers, { operation, attempt, kind: "DeliveryClock", status: "Running" }]
    },
    commands: [{ kind: "PrepareDelivery", attempt, operation, registrationId: state.registration.registrationId }]
  }
}
const preparedResponse = (state: ResponseState, event: Extract<ResponseEvent, { kind: "DeliveryPrepared" }>) => {
  const current = state.current
  if (
    current?.attempt !== event.attempt ||
    current.work.kind !== "PreparingDelivery" ||
    current.work.operation !== event.operation
  )
    return undefined
  return current
}
export const deliveryPrepared = (
  state: ResponseState,
  event: Extract<ResponseEvent, { kind: "DeliveryPrepared" }>,
  attachmentMillis: number
): ResponseDecision => {
  const current = preparedResponse(state, event)
  if (current === undefined) return unchangedResponse(state)
  if (state.registration?.registrationId !== event.registrationId || current.authorization !== "Active")
    return selectTerminal(state, current, "Interrupted", "Detached")
  const ticket = {
    registrationId: event.registrationId,
    deliveryId: event.deliveryId,
    responseId: current.responseId,
    inputDeliveryId: current.input.deliveryId,
    deadlineAt: event.now + state.registration.completionMillis
  }
  const update = {
    kind: "Started" as const,
    registrationId: ticket.registrationId,
    sequence: state.registration.update.sequence + 1,
    ticket
  }
  const timer = state.nextToken
  const context = beginContext(
    updateDelivery(
      {
        ...state,
        nextToken: timer + 1n,
        workers: [
          ...state.workers,
          { operation: timer, attempt: current.attempt, kind: "DeliveryTimer", status: "Running" }
        ]
      },
      update
    ),
    { ...current, ticket },
    attachmentMillis
  )
  return {
    state: context.state,
    commands: [
      { kind: "OpenTicket", ticket },
      { kind: "PublishDelivery", update },
      { kind: "ScheduleDeadline", attempt: current.attempt, operation: timer, ticket },
      ...context.commands
    ]
  }
}
export const contextReady = (
  state: ResponseState,
  event: Extract<ResponseEvent, { kind: "ContextReady" }>
): ResponseDecision => {
  const current = state.current
  if (
    current?.attempt !== event.attempt ||
    current.work.kind !== "PreparingContext" ||
    current.work.operation !== event.operation ||
    current.authorization !== "Active"
  )
    return unchangedResponse(state)
  if (event.snapshot.state !== "ready")
    return failResponse(state, current, {
      code: event.snapshot.state === "failed" ? "MemoryFailed" : "MemoryPending",
      message: "Prior memory is not ready; no answer was generated"
    })
  const operation = state.nextToken
  return {
    state: {
      ...state,
      nextToken: operation + 1n,
      current: { ...current, work: { kind: "Generating", operation, completed: false } },
      workers: [...state.workers, { operation, attempt: current.attempt, kind: "Provider", status: "Running" }]
    },
    commands: [
      {
        kind: "Generate",
        attempt: current.attempt,
        operation,
        input: current.input,
        responseId: current.responseId,
        responseLanguage: current.responseLanguage,
        prior: event.snapshot.text
      }
    ]
  }
}
const activeGeneration = (state: ResponseState, event: { readonly attempt: bigint; readonly operation: bigint }) => {
  const current = state.current
  if (
    current?.attempt !== event.attempt ||
    current.work.kind !== "Generating" ||
    current.work.operation !== event.operation ||
    current.authorization !== "Active"
  )
    return undefined
  return { ...current, work: current.work }
}
export const providerEvent = (
  state: ResponseState,
  event: Extract<ResponseEvent, { kind: "ProviderEvent" }>
): ResponseDecision => {
  const current = activeGeneration(state, event)
  if (current === undefined) return unchangedResponse(state)
  if (current.work.completed)
    return failResponse(state, current, { code: "ProviderFailed", message: "Provider emitted after terminal" })
  if (event.event.kind === "Completed")
    return updateResponse(state, { ...current, work: { ...current.work, completed: true } })
  const text = current.text + event.event.text
  const languageSpans = [
    ...current.languageSpans,
    ...event.event.languageSpans.map((span) => ({
      ...span,
      start: span.start + current.text.length,
      end: span.end + current.text.length
    }))
  ]
  if (
    text.length > maximumReplyLength ||
    !Schema.is(LanguageSpans)(languageSpans) ||
    !validLanguageSpans(text, languageSpans)
  )
    return failResponse(state, current, {
      code: "ProviderFailed",
      message: "Provider output exceeds bounded valid text and annotations"
    })
  return updateResponse(state, { ...current, text, languageSpans, sequence: current.sequence + 1 })
}
export const providerEnded = (
  state: ResponseState,
  event: Extract<ResponseEvent, { kind: "ProviderEnded" }>
): ResponseDecision => {
  const current = activeGeneration(state, event)
  if (current === undefined) return unchangedResponse(state)
  if (!current.work.completed || current.text.length === 0)
    return failResponse(state, current, {
      code: "ProviderFailed",
      message: "Provider stream lacks nonempty completed answer"
    })
  return current.ticket === undefined
    ? selectTerminal(state, current, "Completed")
    : updateResponse(state, {
        ...current,
        sequence: current.sequence + 1,
        work: { kind: "AwaitingDelivery", ticket: current.ticket }
      })
}
