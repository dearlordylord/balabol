import { Match } from "effect"
import type { OutputState } from "./output-state.ts"
import type { OutputEvent, OutputTransition } from "./output-events.ts"
import { failOutput, terminateOutput } from "./output-transition-control.ts"
import {
  closeAcknowledged,
  closeFailed,
  unregisterFailed,
  unregisterAcknowledged
} from "./output-transition-cleanup.ts"
import {
  outputOperation,
  keyedOutputOperation,
  outputResult,
  removeOutputOperation,
  replaceOutputOperation,
  reserveOutput,
  liveOutput,
  unchangedOutput
} from "./output-transition-result.ts"
const drained = (state: OutputState, event: Extract<OutputEvent, { kind: "Drained" }>): OutputTransition => {
  const entry = keyedOutputOperation(state, event)
  if (entry?.kind !== "Drain") return unchangedOutput(state)
  const retired = removeOutputOperation(state, event.operation)
  const selected = liveOutput(retired, event.key)
  if (selected === null || entry.status === "Cancelling" || selected.phase !== "Draining") return outputResult(retired)
  const operation = retired.nextOperation
  const reserved = reserveOutput(retired, {
    kind: "Settlement",
    operation,
    key: event.key,
    outcome: "Completed",
    error: null,
    status: "Reserved"
  })
  return outputResult({ ...reserved, selected: { ...selected, phase: "Settling" } }, [
    { kind: "SettleDelivery", operation, key: event.key, outcome: "Completed", error: null }
  ])
}
const pendingSettlement = (
  state: OutputState,
  event: Extract<OutputEvent, { kind: "DeliverySettled" | "DeliveryRejected" }>
) => {
  const entry = keyedOutputOperation(state, event)
  return entry?.kind === "Settlement" && entry.status !== "Rejected" ? entry : null
}
const deliveryRejected = (
  state: OutputState,
  event: Extract<OutputEvent, { kind: "DeliveryRejected" }>
): OutputTransition => {
  const entry = pendingSettlement(state, event)
  if (entry === null) return unchangedOutput(state)
  const rejected = replaceOutputOperation(state, { ...entry, status: "Rejected" })
  return liveOutput(rejected, event.key) === null
    ? outputResult(rejected)
    : terminateOutput(rejected, "Failed", event.error)
}
const deliveryApplied = (
  state: OutputState,
  event: Extract<OutputEvent, { kind: "DeliverySettled" }>
): OutputTransition => {
  const entry = pendingSettlement(state, event)
  if (entry === null) return unchangedOutput(state)
  const retired = removeOutputOperation(state, event.operation)
  return entry.outcome === "Completed" && liveOutput(retired, event.key) !== null
    ? terminateOutput(retired, "Delivered", null)
    : outputResult(retired)
}
const interrupted = (
  state: OutputState,
  event: Extract<OutputEvent, { kind: "InterruptApplied" | "InterruptRejected" }>
): OutputTransition => {
  const entry = outputOperation(state, event.operation)
  if (
    entry?.kind !== "InterruptResponse" ||
    entry.status === "Rejected" ||
    entry.target.responseId !== event.target.responseId ||
    entry.target.inputDeliveryId !== event.target.inputDeliveryId
  )
    return unchangedOutput(state)
  return event.kind === "InterruptApplied"
    ? outputResult(removeOutputOperation(state, event.operation))
    : {
        ...outputResult(replaceOutputOperation(state, { ...entry, status: "Rejected" })),
        decision: { kind: "Rejected", error: event.error }
      }
}
const unregistered = (
  state: OutputState,
  event: Extract<OutputEvent, { kind: "Unregistered" | "UnregisterRejected" }>
): OutputTransition => {
  const entry = outputOperation(state, event.operation)
  if (entry?.kind !== "UnregisterAttempt" || entry.registrationId !== event.registrationId)
    return unchangedOutput(state)
  if (event.kind === "UnregisterRejected") return unregisterFailed(state, entry, event.error)
  return unregisterAcknowledged(state, entry)
}
const released = (state: OutputState, event: Extract<OutputEvent, { kind: "Released" }>): OutputTransition => {
  const entry = outputOperation(state, event.operation)
  if (entry?.kind === "CloseAttempt") return closeAcknowledged(state, entry)
  if (entry === undefined || entry.status !== "Cancelling") return unchangedOutput(state)
  return outputResult(removeOutputOperation(state, event.operation))
}
const failed = (state: OutputState, event: Extract<OutputEvent, { kind: "WorkFailed" }>): OutputTransition => {
  const entry = keyedOutputOperation(state, event)
  if (entry === undefined) return unchangedOutput(state)
  if (entry.kind === "CloseAttempt") return closeFailed(state, entry, event.error)
  if (entry.kind === "Publication" && entry.status === "Releasing")
    return { ...outputResult(state), decision: { kind: "Rejected", error: event.error } }
  const retired = removeOutputOperation(state, event.operation)
  return entry.status === "Cancelling" || liveOutput(retired, event.key) === null
    ? outputResult(retired)
    : failOutput(retired, event.error)
}
type SettlementEvent = Extract<
  OutputEvent,
  {
    kind:
      | "Drained"
      | "DeliverySettled"
      | "DeliveryRejected"
      | "InterruptApplied"
      | "InterruptRejected"
      | "Unregistered"
      | "UnregisterRejected"
      | "Released"
      | "WorkFailed"
  }
>
const dispatchSettlement = Match.type<SettlementEvent & { readonly state: OutputState }>().pipe(
  Match.discriminatorsExhaustive("kind")({
    Drained: (event) => drained(event.state, event),
    DeliverySettled: (event) => deliveryApplied(event.state, event),
    DeliveryRejected: (event) => deliveryRejected(event.state, event),
    InterruptApplied: (event) => interrupted(event.state, event),
    InterruptRejected: (event) => interrupted(event.state, event),
    Unregistered: (event) => unregistered(event.state, event),
    UnregisterRejected: (event) => unregistered(event.state, event),
    Released: (event) => released(event.state, event),
    WorkFailed: (event) => failed(event.state, event)
  })
)
export const transitionOutputSettlement = (state: OutputState, event: SettlementEvent): OutputTransition =>
  dispatchSettlement({ ...event, state })
