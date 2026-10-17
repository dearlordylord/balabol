import type { OutputCommand, OutputEvent } from "./output-events.ts"
import { outputProjection } from "./output-state.ts"
import { transitionOutput } from "./output-transition.ts"
import type { SessionState } from "./session-state.ts"
import { failed } from "./contracts.ts"
import { emit, unchanged } from "./session-transition-result.ts"
import type { SessionTransition } from "./session-transition-result.ts"

type TraceCommand = Extract<OutputCommand, { kind: "Trace" }>
const targetMetadata = (target: TraceCommand["target"]) =>
  target === undefined
    ? {}
    : {
        responseId: target.responseId,
        inputDeliveryId: target.inputDeliveryId,
        ...(target.outputEpoch === undefined ? {} : { outputEpoch: target.outputEpoch })
      }
const projectionMetadata = (state: SessionState, target: TraceCommand["target"]) => {
  const output = outputProjection(state.output)
  if (output === null) return {}
  if (
    target !== undefined &&
    (output.responseId !== target.responseId || output.inputDeliveryId !== target.inputDeliveryId)
  )
    return {}
  return {
    responseId: output.responseId,
    inputDeliveryId: output.inputDeliveryId,
    outputEpoch: output.outputEpoch,
    priorStatus: output.status
  }
}
const traceInput = (state: SessionState, command: TraceCommand) => ({
  sessionId: state.id,
  cause: command.cause,
  ...(command.errorCode === undefined ? {} : { errorCode: command.errorCode }),
  ...(command.failureReason === undefined ? {} : { failureReason: command.failureReason }),
  applied: command.applied,
  ...projectionMetadata(state, command.target),
  ...targetMetadata(command.target),
  ...(command.priorStatus === undefined ? {} : { priorStatus: command.priorStatus }),
  ...(command.generation === undefined ? {} : { generation: command.generation })
})
const project = (state: SessionState, command: OutputCommand): SessionTransition => {
  switch (command.kind) {
    case "Project":
      return emit(state, { kind: "Output", output: command.output })
    case "Trace":
      return { state, commands: [{ kind: "TraceOutput", input: traceInput(state, command) }] }
    default:
      return { state, commands: [{ kind: "OutputWork", command }] }
  }
}

/** Output shares this writer with capture and admission. Commit its gate first;
 * interpret revocation before the enclosing speech fence or closure commands. */
export const composeSessionOutput = (before: SessionTransition, input: OutputEvent): SessionTransition => {
  const result = transitionOutput(before.state.output, input, before.state.outputContext)
  const next = result.commands.reduce<SessionTransition>(
    (transition, command) => {
      const after = project(transition.state, command)
      return { ...after, commands: [...transition.commands, ...after.commands] }
    },
    { state: { ...before.state, output: result.state }, commands: [] }
  )
  return {
    ...before,
    state: next.state,
    commands: [...next.commands, ...before.commands],
    outputDecision: result.decision,
    ...(result.decision.kind === "Rejected"
      ? { error: failed(result.decision.error.code, result.decision.error.message) }
      : {})
  }
}
export const transitionSessionOutput = (state: SessionState, input: OutputEvent): SessionTransition =>
  composeSessionOutput(unchanged(state), input)
