import { sameDetectedLanguage } from "./contracts.ts"
import type { SessionState } from "./session-state.ts"
import { finalInput, replaceFinal } from "./session-state.ts"
import type { SessionEvent } from "./session-events.ts"
import { unchanged, emit } from "./session-transition-result.ts"
import type { SessionTransition } from "./session-transition-result.ts"
import { composeSessionOutput } from "./session-transition-output.ts"
const lastEventOffset = -1
type AdmissionEvent = Extract<SessionEvent, { kind: "Prepared" | "Accepted" | "AdmissionFailed" | "AdmissionFinished" }>
const accepted = (state: SessionState, event: Extract<SessionEvent, { kind: "Accepted" }>): SessionTransition => {
  const input = state.unresolved.find((item) => item.id === event.id)
  const receipt = event.receipt
  if (
    input === undefined ||
    receipt.role !== "user" ||
    receipt.deliveryId !== event.id ||
    receipt.text !== input.text ||
    JSON.stringify(receipt.languageSpans) !== JSON.stringify(input.languageSpans) ||
    !sameDetectedLanguage(receipt.detectedLanguage, input.detectedLanguage)
  )
    return unchanged(state)
  return emit(
    {
      ...state,
      unresolved: state.unresolved.filter((item) => item.id !== event.id),
      finals: replaceFinal(state, finalInput(state, input, receipt, null))
    },
    { kind: "Accepted", utteranceId: event.id, receipt }
  )
}
const prepared = (
  state: SessionState,
  input: Extract<SessionEvent, { kind: "Prepared" }>["input"]
): SessionTransition => {
  if (!state.admitting.includes(input.id) || state.unresolved.some((item) => item.id === input.id))
    return unchanged(state)
  const result = emit(
    {
      ...state,
      unresolved: [...state.unresolved, input],
      finals: replaceFinal(state, finalInput(state, input, null, null))
    },
    {
      kind: "Final",
      backendIncarnationId: state.incarnation,
      utteranceId: input.id,
      deliveryId: input.id,
      text: input.text,
      languageSpans: input.languageSpans,
      detectedLanguage: input.detectedLanguage
    }
  )
  const event = result.state.events.at(lastEventOffset)
  return {
    state: result.state,
    commands: event === undefined ? [] : [{ kind: "SubmitAdmission", id: input.id, event }]
  }
}
const admissionFailed = (
  state: SessionState,
  event: Extract<SessionEvent, { kind: "AdmissionFailed" }>
): SessionTransition => {
  if (!state.admitting.includes(event.id)) return unchanged(state)
  if (state.finals.some((item) => item.utteranceId === event.id && item.receipt !== null)) return unchanged(state)
  const input = state.unresolved.find((item) => item.id === event.id)
  const next =
    event.handed && input !== undefined
      ? {
          ...state,
          finals: replaceFinal(state, finalInput(state, input, null, { code: event.code, message: event.message }))
        }
      : state
  return emit(next, { kind: "Error", utteranceId: event.id, code: event.code, message: event.message })
}
export const transitionAdmission = (state: SessionState, event: AdmissionEvent): SessionTransition => {
  switch (event.kind) {
    case "Prepared":
      return prepared(state, event.input)
    case "Accepted":
      return accepted(state, event)
    case "AdmissionFailed":
      return admissionFailed(state, event)
    case "AdmissionFinished":
      return !state.admitting.includes(event.id)
        ? unchanged(state)
        : composeSessionOutput(
            { state: { ...state, admitting: state.admitting.filter((id) => id !== event.id) }, commands: [] },
            { kind: "AdmissionReleased", inputDeliveryId: event.id }
          )
  }
}
