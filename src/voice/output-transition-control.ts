import type { ResponseTarget } from "../conversation/index.ts"
import type { OutputState, OutputError } from "./output-state.ts"
import { outputProjection } from "./output-state.ts"
import { suppressAdmissions, admissionReleased, settleSuppressions } from "./output-transition-suppression.ts"
import type { OutputEvent, OutputTransition, OutputCommand } from "./output-events.ts"
import { cancelOutputWork } from "./output-transition-resources.ts"
import {
  continueOutput,
  outputResult,
  outputTerminal,
  reserveOutput,
  unchangedOutput
} from "./output-transition-result.ts"
const maximumError = 1000
export const terminateOutput = (
  state: OutputState,
  phase: "Interrupted" | "Failed" | "Delivered",
  error: OutputError | null
): OutputTransition => {
  const selected = state.selected
  if (selected === null) return unchangedOutput(state)
  return cancelOutputWork({ ...state, selected: { ...selected, phase, error } }, selected.key)
}
export const failOutput = (state: OutputState, error: OutputError): OutputTransition => {
  const selected = state.selected
  if (selected === null || outputTerminal(selected.phase)) return unchangedOutput(state)
  const result = terminateOutput(state, "Failed", { ...error, message: error.message.slice(0, maximumError) })
  const operation = result.state.nextOperation
  return {
    ...result,
    state: reserveOutput(result.state, {
      kind: "Settlement",
      operation,
      key: selected.key,
      outcome: "Failed",
      error,
      status: "Reserved"
    }),
    commands: [
      ...result.commands,
      {
        kind: "Trace",
        cause: "failed",
        applied: true,
        target: { ...selected.key.ticket, outputEpoch: selected.key.outputEpoch },
        priorStatus: outputProjection(state)?.status
      },
      { kind: "SettleDelivery", operation, key: selected.key, outcome: "Failed", error }
    ]
  }
}
const interruptTarget = (state: OutputState, target: ResponseTarget, acknowledge = false): OutputTransition => {
  const operation = state.nextOperation
  return outputResult(reserveOutput(state, { kind: "InterruptResponse", operation, target, status: "Reserved" }), [
    { kind: "InterruptResponse", operation, target, ...(acknowledge ? { acknowledge: true } : {}) }
  ])
}
const speechDiagnostic = (
  state: OutputState,
  event: Extract<OutputEvent, { kind: "Speech" }>,
  applied: boolean
): OutputCommand => {
  const selected = state.selected
  return {
    kind: "Trace",
    cause: "backendSpeech",
    applied,
    ...(selected === null
      ? {}
      : {
          priorStatus: outputProjection(state)?.status,
          target: { ...selected.key.ticket, outputEpoch: selected.key.outputEpoch }
        }),
    ...(event.generation === undefined ? {} : { generation: event.generation })
  }
}
const speech = (state: OutputState, event: Extract<OutputEvent, { kind: "Speech" }>): OutputTransition => {
  if (state.retired || event.sequence <= state.latestSpeechSequence) return unchangedOutput(state)
  const suppressed = suppressAdmissions(state, event)
  const selected = state.selected
  const applied = selected !== null && !outputTerminal(selected.phase)
  const trace = speechDiagnostic(state, event, applied)
  if (!applied) return outputResult(suppressed, [trace])
  const result = continueOutput(terminateOutput(suppressed, "Interrupted", null), (current) =>
    interruptTarget(current, selected.key.ticket)
  )
  return { ...result, commands: [trace, ...result.commands] }
}
const matchesTarget = (state: OutputState, target: ResponseTarget): boolean =>
  state.selected?.key.ticket.responseId === target.responseId &&
  state.selected.key.ticket.inputDeliveryId === target.inputDeliveryId
const interrupt = (state: OutputState, event: Extract<OutputEvent, { kind: "Interrupt" }>): OutputTransition => {
  const selected = state.selected
  const input = event.input
  const matched = matchesTarget(state, input)
  const applied =
    selected !== null && matched && !outputTerminal(selected.phase) && selected.key.outputEpoch === input.outputEpoch
  const trace: OutputCommand = {
    kind: "Trace",
    cause: "clientInterrupt",
    applied,
    target: input,
    ...(matched ? { priorStatus: outputProjection(state)?.status } : {})
  }
  if (!applied) return { ...unchangedOutput(state), commands: [trace] }
  const result = continueOutput(terminateOutput(state, "Interrupted", null), (current) =>
    interruptTarget(current, input, true)
  )
  return {
    ...result,
    decision: { kind: "Applied", operation: state.nextOperation },
    commands: [trace, ...result.commands]
  }
}
const retire = (state: OutputState): OutputTransition => {
  const retired = { ...state, retired: true, suppressedAdmissions: [] }
  const selected = state.selected
  if (selected === null || selected.phase === "Delivered") return cancelOutputWork(retired, null)
  const result = terminateOutput(retired, selected.phase === "Failed" ? "Failed" : "Interrupted", selected.error)
  return {
    ...result,
    commands: [
      {
        kind: "Trace",
        cause: "detach",
        applied: true,
        target: { ...selected.key.ticket, outputEpoch: selected.key.outputEpoch },
        priorStatus: outputProjection(state)?.status
      },
      ...result.commands
    ]
  }
}
export const transitionOutputControl = (
  state: OutputState,
  event: Extract<OutputEvent, { kind: "Speech" | "FenceSettled" | "Interrupt" | "AdmissionReleased" | "Retire" }>
): OutputTransition => {
  switch (event.kind) {
    case "Speech":
      return speech(state, event)
    case "FenceSettled":
      return outputResult(settleSuppressions(state, event))
    case "Interrupt":
      return interrupt(state, event)
    case "AdmissionReleased":
      return outputResult(admissionReleased(state, event.inputDeliveryId))
    case "Retire":
      return retire(state)
  }
}
