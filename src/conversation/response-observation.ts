import { awaitResponseCleanup } from "./response-cleanup.ts"
import type { ResponseAttempt, ResponseState } from "./response-state.ts"
import { ticketMatches } from "./response-state.ts"
import type { ResponseEvent } from "./response-events.ts"
import { done, failResponse, selectTerminal, unchangedResponse, type ResponseDecision } from "./response-decisions.ts"

export const observeResponse = (
  state: ResponseState,
  event: Extract<ResponseEvent, { kind: "Observe" }>
): ResponseDecision => ({
  state:
    state.current?.input.deliveryId === event.inputDeliveryId
      ? { ...state, current: { ...state.current, observer: event.token } }
      : state,
  commands: [{ kind: "Resolve", requestId: event.requestId, result: { kind: "Observer", token: event.token } }]
})
const cancellable = (current: ResponseAttempt | undefined, inputDeliveryId: string): current is ResponseAttempt =>
  current !== undefined &&
  current.input.deliveryId === inputDeliveryId &&
  current.ticket === undefined &&
  current.work.kind !== "Failed" &&
  current.work.kind !== "Terminal"

const failedInput = (
  current: ResponseAttempt | undefined,
  inputDeliveryId: string
): current is ResponseAttempt & { readonly work: Extract<ResponseAttempt["work"], { kind: "Failed" }> } =>
  current?.input.deliveryId === inputDeliveryId && current.work.kind === "Failed"
export const cancelResponse = (
  state: ResponseState,
  event: Extract<ResponseEvent, { kind: "Cancel" }>
): ResponseDecision => {
  const current = state.current
  if (failedInput(current, event.inputDeliveryId))
    return awaitResponseCleanup(state, current, { requestId: event.requestId, result: "Done" })
  if (!cancellable(current, event.inputDeliveryId)) return { state, commands: [done(event.requestId)] }
  if (current.work.kind === "Settling" && current.work.write === "Failed")
    return { state, commands: [done(event.requestId)] }
  if (current.work.kind === "Settling")
    return {
      state: {
        ...state,
        current: {
          ...current,
          waiters: [...current.waiters, { requestId: event.requestId, result: "Done", failure: "Ignore" }]
        }
      },
      commands: []
    }
  const failed = failResponse(state, current, { code: "Cancelled", message: "Reply observer disconnected" })
  const cleanup = awaitResponseCleanup(failed.state, current, { requestId: event.requestId, result: "Done" })
  return { state: cleanup.state, commands: [...failed.commands, ...cleanup.commands] }
}
export const releaseResponse = (
  state: ResponseState,
  event: Extract<ResponseEvent, { kind: "Release" }>
): ResponseDecision =>
  state.current?.observer === event.token
    ? cancelResponse(state, { kind: "Cancel", requestId: event.requestId, inputDeliveryId: event.inputDeliveryId })
    : { state, commands: [done(event.requestId)] }

const observerless = (current: ResponseAttempt) =>
  cancellable(current, current.input.deliveryId) && current.observer === undefined && current.work.kind !== "Settling"
export const attachmentExpired = (
  state: ResponseState,
  event: Extract<ResponseEvent, { kind: "AttachmentExpired" }>
): ResponseDecision =>
  state.current?.attempt === event.attempt && observerless(state.current)
    ? failResponse(state, state.current, { code: "Cancelled", message: "Reply observer disconnected" })
    : unchangedResponse(state)

export const deliveryDeadlineExpired = (
  state: ResponseState,
  event: Extract<ResponseEvent, { kind: "DeadlineExpired" }>
): ResponseDecision =>
  state.current?.attempt === event.attempt &&
  state.current.authorization === "Active" &&
  ticketMatches(state.current.ticket, event.ticket)
    ? selectTerminal(state, state.current, "Interrupted", "Deadline", {
        code: "AudioUnavailable",
        reason: "DeliveryDeadline",
        message: "Reply delivery exceeded its deadline"
      })
    : unchangedResponse(state)
