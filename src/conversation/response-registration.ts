import type { ResponseAttempt, ResponseState } from "./response-state.ts"
import type { ResponseEvent } from "./response-events.ts"
import type { ReplyDeliveryUpdate } from "./delivery.ts"
import { done, selectTerminal, type ResponseDecision } from "./response-decisions.ts"
import { ReplyBusy, StorageUnavailable } from "./contracts.ts"

export const registerDelivery = (
  state: ResponseState,
  event: Extract<ResponseEvent, { kind: "Register" }>
): ResponseDecision => {
  if (state.registration !== undefined)
    return {
      state,
      commands: [
        {
          kind: "Reject",
          requestId: event.requestId,
          error: new ReplyBusy({ message: "A voice delivery session is already attached" })
        }
      ]
    }
  const update: ReplyDeliveryUpdate = { kind: "Idle", registrationId: event.registrationId, sequence: 0 }
  return {
    state: {
      ...state,
      registration: { registrationId: event.registrationId, completionMillis: event.completionMillis, update }
    },
    commands: [
      {
        kind: "Resolve",
        requestId: event.requestId,
        result: { kind: "Registered", registrationId: event.registrationId, snapshot: update }
      }
    ]
  }
}
const attachedResponse = (current: ResponseAttempt | undefined, registrationId: string): current is ResponseAttempt =>
  current !== undefined &&
  (current.ticket?.registrationId === registrationId ||
    (current.work.kind === "PreparingDelivery" && current.work.registrationId === registrationId)) &&
  current.work.kind !== "Terminal" &&
  current.work.kind !== "Failed"

const failedAttachedSettlement = (current: ResponseAttempt | undefined, registrationId: string) => {
  if (!attachedResponse(current, registrationId) || current.work.kind !== "Settling" || current.work.write !== "Failed")
    return undefined
  return new StorageUnavailable({ message: current.work.failure?.message ?? "Terminal persistence unavailable" })
}
export const detachDelivery = (
  state: ResponseState,
  event: Extract<ResponseEvent, { kind: "Detach" }>
): ResponseDecision => {
  if (state.registration?.registrationId !== event.registrationId) return { state, commands: [done(event.requestId)] }
  const current = state.current
  const failure = failedAttachedSettlement(current, event.registrationId)
  if (failure !== undefined)
    return {
      state: { ...state, registration: undefined },
      commands: [
        { kind: "Reject", requestId: event.requestId, error: failure },
        { kind: "CloseSubscription", registrationId: event.registrationId }
      ]
    }
  // Revocation must see the registration's last sequence before it is retired.
  const interrupted = attachedResponse(current, event.registrationId)
    ? selectTerminal(
        state,
        { ...current, waiters: [...current.waiters, { requestId: event.requestId, result: "Done" }] },
        "Interrupted",
        "Detached"
      )
    : { state, commands: [done(event.requestId)] }
  return {
    state: { ...interrupted.state, registration: undefined },
    commands: [...interrupted.commands, { kind: "CloseSubscription", registrationId: event.registrationId }]
  }
}
