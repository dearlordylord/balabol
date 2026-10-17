import type { OutputState, SuppressedAdmission } from "./output-state.ts"
import type { OutputEvent } from "./output-events.ts"
const retained = (record: SuppressedAdmission): boolean => !record.admissionFinished || record.fenceStatus !== "Applied"
export const suppressAdmissions = (
  state: OutputState,
  event: Extract<OutputEvent, { kind: "Speech" }>
): OutputState => {
  const previous = state.suppressedAdmissions
  const added = event.suppress.map(
    (inputDeliveryId): SuppressedAdmission => ({
      inputDeliveryId,
      fenceId: event.fenceId,
      sequence: event.sequence,
      fenceStatus: "Pending",
      admissionFinished: previous.some(
        (record) => record.inputDeliveryId === inputDeliveryId && record.admissionFinished
      )
    })
  )
  return {
    ...state,
    latestSpeechSequence: event.sequence,
    suppressedAdmissions: [...previous.filter((record) => !event.suppress.includes(record.inputDeliveryId)), ...added]
  }
}
export const admissionReleased = (state: OutputState, inputDeliveryId: string): OutputState => ({
  ...state,
  suppressedAdmissions: state.suppressedAdmissions
    .map((record) => (record.inputDeliveryId === inputDeliveryId ? { ...record, admissionFinished: true } : record))
    .filter(retained)
})
const settleRecord = (
  record: SuppressedAdmission,
  event: Extract<OutputEvent, { kind: "FenceSettled" }>
): SuppressedAdmission => {
  if (event.status === "Applied" && record.sequence <= event.sequence) return { ...record, fenceStatus: "Applied" }
  return record.fenceStatus === "Pending" && record.fenceId === event.fenceId && record.sequence === event.sequence
    ? { ...record, fenceStatus: event.status }
    : record
}
/** A matching later applied source fence also revokes older source intents.
 * New handoff requires that acknowledgement, so finished records retire before
 * fresh handed IDs can accumulate; rejection never pretends to acknowledge it. */
export const settleSuppressions = (
  state: OutputState,
  event: Extract<OutputEvent, { kind: "FenceSettled" }>
): OutputState =>
  event.sequence > state.latestSpeechSequence || state.retired
    ? state
    : {
        ...state,
        suppressedAdmissions: state.suppressedAdmissions.map((record) => settleRecord(record, event)).filter(retained)
      }
export const forgetSuppression = (state: OutputState, inputDeliveryId: string): OutputState => ({
  ...state,
  suppressedAdmissions: state.suppressedAdmissions.filter((record) => record.inputDeliveryId !== inputDeliveryId)
})
