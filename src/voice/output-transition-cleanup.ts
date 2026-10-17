import type { OutputState, OutputObligation, OutputError } from "./output-state.ts"
import type { OutputTransition } from "./output-events.ts"
import {
  outputOperation,
  outputResult,
  removeOutputOperation,
  replaceOutputOperation,
  reserveOutput,
  unchangedOutput
} from "./output-transition-result.ts"
const releaseRetryMillis = 100
type Publication = Extract<OutputObligation, { kind: "Publication" }>
type Unregistration = Extract<OutputObligation, { kind: "Unregistration" }>
type UnregisterAttempt = Extract<OutputObligation, { kind: "UnregisterAttempt" }>
const unregisterParent = (state: OutputState, child: UnregisterAttempt): Unregistration | null => {
  const parent = outputOperation(state, child.parentOperation)
  return parent?.kind === "Unregistration" && parent.registrationId === child.registrationId ? parent : null
}
export const closeAttempt = (state: OutputState, parent: Publication, delayMillis: number): OutputTransition => {
  const operation = state.nextOperation
  return outputResult(
    reserveOutput(state, {
      kind: "CloseAttempt",
      operation,
      parentOperation: parent.operation,
      key: parent.key,
      status: "Reserved"
    }),
    [{ kind: "ClosePublication", operation, parentOperation: parent.operation, delayMillis }]
  )
}
export const unregisterAttempt = (
  state: OutputState,
  parent: Unregistration,
  delayMillis: number
): OutputTransition => {
  const operation = state.nextOperation
  return outputResult(
    reserveOutput(state, {
      kind: "UnregisterAttempt",
      operation,
      parentOperation: parent.operation,
      registrationId: parent.registrationId,
      status: "Reserved"
    }),
    [
      {
        kind: "Unregister",
        operation,
        parentOperation: parent.operation,
        registrationId: parent.registrationId,
        delayMillis
      }
    ]
  )
}
export const closeFailed = (
  state: OutputState,
  child: Extract<OutputObligation, { kind: "CloseAttempt" }>,
  error: OutputError
): OutputTransition => {
  const parent = outputOperation(state, child.parentOperation)
  if (parent?.kind !== "Publication" || parent.status !== "Releasing") return unchangedOutput(state)
  const failed = { ...parent, releaseError: error }
  const retired = replaceOutputOperation(removeOutputOperation(state, child.operation), failed)
  return closeAttempt(retired, failed, releaseRetryMillis)
}
export const unregisterFailed = (
  state: OutputState,
  child: Extract<OutputObligation, { kind: "UnregisterAttempt" }>,
  error: OutputError
): OutputTransition => {
  const parent = unregisterParent(state, child)
  if (parent === null) return unchangedOutput(state)
  const failed = { ...parent, releaseError: error }
  const retired = replaceOutputOperation(removeOutputOperation(state, child.operation), failed)
  return unregisterAttempt(retired, failed, releaseRetryMillis)
}
export const unregisterAcknowledged = (state: OutputState, child: UnregisterAttempt): OutputTransition => {
  const parent = unregisterParent(state, child)
  if (parent === null) return unchangedOutput(state)
  return outputResult({
    ...removeOutputOperation(removeOutputOperation(state, child.operation), parent.operation),
    registrationId: null
  })
}
export const closeAcknowledged = (
  state: OutputState,
  child: Extract<OutputObligation, { kind: "CloseAttempt" }>
): OutputTransition => {
  const parent = outputOperation(state, child.parentOperation)
  if (parent?.kind !== "Publication" || parent.status !== "Releasing") return unchangedOutput(state)
  return outputResult(removeOutputOperation(removeOutputOperation(state, child.operation), parent.operation))
}
