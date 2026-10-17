import type { OutputState, OutputKey, OutputObligation } from "./output-state.ts"
import type { OutputTransition, OutputCommand } from "./output-events.ts"
import type { DeliveryTicket } from "../conversation/index.ts"
export const unchangedOutput = (state: OutputState): OutputTransition => ({
  state,
  commands: [],
  decision: { kind: "Ignored" }
})
export const outputResult = (state: OutputState, commands: readonly OutputCommand[] = []): OutputTransition => ({
  state,
  commands,
  decision: { kind: "Applied" }
})
export const continueOutput = (
  step: OutputTransition,
  next: (state: OutputState) => OutputTransition
): OutputTransition => {
  const result = next(step.state)
  return { ...result, commands: [...step.commands, ...result.commands] }
}
export const sameOutputTicket = (left: DeliveryTicket, right: DeliveryTicket): boolean =>
  left.deliveryId === right.deliveryId &&
  left.registrationId === right.registrationId &&
  left.responseId === right.responseId &&
  left.inputDeliveryId === right.inputDeliveryId &&
  left.deadlineAt === right.deadlineAt
export const sameOutputKey = (left: OutputKey, right: OutputKey): boolean =>
  left.outputEpoch === right.outputEpoch && sameOutputTicket(left.ticket, right.ticket)
export const outputOperation = (state: OutputState, operation: number): OutputObligation | undefined =>
  state.obligations.find((entry) => entry.operation === operation)
export const keyedOutputOperation = (
  state: OutputState,
  event: { readonly operation: number; readonly key: OutputKey }
) => {
  const entry = outputOperation(state, event.operation)
  return entry !== undefined && "key" in entry && sameOutputKey(entry.key, event.key) ? entry : undefined
}
export const removeOutputOperation = (state: OutputState, operation: number): OutputState => ({
  ...state,
  obligations: state.obligations.filter((entry) => entry.operation !== operation)
})
export const replaceOutputOperation = (state: OutputState, obligation: OutputObligation): OutputState => ({
  ...state,
  obligations: state.obligations.map((entry) => (entry.operation === obligation.operation ? obligation : entry))
})
export const reserveOutput = (state: OutputState, obligation: OutputObligation): OutputState => ({
  ...state,
  nextOperation: state.nextOperation + 1,
  obligations: [...state.obligations, obligation]
})
export const selectedOutput = (state: OutputState, key: OutputKey) =>
  state.selected !== null && sameOutputKey(state.selected.key, key) ? state.selected : null
export const outputTerminal = (phase: NonNullable<OutputState["selected"]>["phase"]): boolean =>
  phase === "Delivered" || phase === "Interrupted" || phase === "Failed"
export const liveOutput = (state: OutputState, key: OutputKey) => {
  const selected = selectedOutput(state, key)
  return state.retired || selected === null || outputTerminal(selected.phase) ? null : selected
}
