import { Match } from "effect"
import type { ResponseState } from "./response-state.ts"
import type { ResponseEvent } from "./response-events.ts"
import { unchangedResponse, selectTerminal, type ResponseDecision } from "./response-decisions.ts"
import { beginResponse, deliveryPrepared, contextReady, providerEvent, providerEnded } from "./response-generation.ts"
import {
  pendingChecked,
  interruptResponse,
  terminalStored,
  terminalFailed,
  workFinished,
  workFailed,
  settleDelivery
} from "./response-settlement.ts"
import { retryResponse, retryChecked, retryRecovered } from "./response-retry.ts"
import { registerDelivery, detachDelivery } from "./response-registration.ts"
import {
  observeResponse,
  releaseResponse,
  cancelResponse,
  attachmentExpired,
  deliveryDeadlineExpired
} from "./response-observation.ts"

const intentAdvanced = (
  state: ResponseState,
  event: Extract<ResponseEvent, { kind: "IntentAdvanced" }>
): ResponseDecision => {
  const current = state.current
  const advanced = { ...state, revision: event.revision }
  return event.revision === state.revision ||
    current === undefined ||
    current.authorization === "Revoked" ||
    current.work.kind === "Failed" ||
    current.work.kind === "Terminal"
    ? unchangedResponse(advanced)
    : selectTerminal(advanced, current, "Interrupted")
}
const requestFailed = (
  state: ResponseState,
  event: Extract<ResponseEvent, { kind: "RequestFailed" }>
): ResponseDecision => ({
  state: { ...state, retryChecks: state.retryChecks.filter((check) => check.requestId !== event.requestId) },
  commands: [{ kind: "Reject", requestId: event.requestId, error: event.error }]
})

export const transitionResponse = (
  state: ResponseState,
  event: ResponseEvent,
  languages: readonly string[],
  attachmentMillis: number
): ResponseDecision =>
  Match.value(event).pipe(
    Match.discriminatorsExhaustive("kind")({
      Retry: (event) => retryResponse(state, event),
      RetryChecked: (event) => retryChecked(state, event),
      RetryRecovered: (event) => retryRecovered(state, event, languages, attachmentMillis),
      PendingChecked: (event) => pendingChecked(state, event),
      Start: (event) => beginResponse(state, event, languages, attachmentMillis),
      DeliveryPrepared: (event) => deliveryPrepared(state, event, attachmentMillis),
      ContextReady: (event) => contextReady(state, event),
      ProviderEvent: (event) => providerEvent(state, event),
      ProviderEnded: (event) => providerEnded(state, event),
      Admit: (event) => interruptResponse(state, event),
      Interrupt: (event) => interruptResponse(state, event),
      TerminalStored: (event) => terminalStored(state, event),
      TerminalFailed: (event) => terminalFailed(state, event),
      WorkFinished: (event) => workFinished(state, event),
      WorkFailed: (event) => workFailed(state, event),
      Settle: (event) => settleDelivery(state, event),
      IntentAdvanced: (event) => intentAdvanced(state, event),
      Register: (event) => registerDelivery(state, event),
      Detach: (event) => detachDelivery(state, event),
      Observe: (event) => observeResponse(state, event),
      Release: (event) => releaseResponse(state, event),
      Cancel: (event) => cancelResponse(state, event),
      AttachmentExpired: (event) => attachmentExpired(state, event),
      DeadlineExpired: (event) => deliveryDeadlineExpired(state, event),
      RequestFailed: (event) => requestFailed(state, event)
    })
  )
