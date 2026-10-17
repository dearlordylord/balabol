import type { OutputState, OutputContext, OutputKey } from "./output-state.ts"
import type { OutputEvent, OutputTransition } from "./output-events.ts"
import { failOutput } from "./output-transition-control.ts"
import {
  keyedOutputOperation,
  outputResult,
  reserveOutput,
  replaceOutputOperation,
  removeOutputOperation,
  liveOutput,
  sameOutputKey,
  unchangedOutput
} from "./output-transition-result.ts"
const readinessMillis = 5000
const opened = (
  state: OutputState,
  event: Extract<OutputEvent, { kind: "PublicationOpened" }>,
  context: OutputContext
): OutputTransition => {
  const entry = keyedOutputOperation(state, event)
  if (entry?.kind !== "Publication") return unchangedOutput(state)
  const attached = replaceOutputOperation(state, { ...entry, status: "Open" })
  const selected = liveOutput(attached, event.key)
  if (selected === null || selected.publicationOperation !== event.operation) return outputResult(attached)
  const manifest = {
    sessionId: context.sessionId,
    responseId: event.key.ticket.responseId,
    inputDeliveryId: event.key.ticket.inputDeliveryId,
    outputEpoch: event.key.outputEpoch,
    publisherIdentity: event.publisherIdentity,
    trackSid: event.trackSid,
    sourceAudio: { encoding: "pcm-s16le", sampleRateHz: 24000, channels: 1 }
  } satisfies NonNullable<typeof selected.manifest>
  const operation = attached.nextOperation
  const reserved = reserveOutput(attached, {
    kind: "ReadyTimer",
    operation,
    key: event.key,
    parentOperation: event.operation,
    status: "Reserved"
  })
  return outputResult({ ...reserved, selected: { ...selected, phase: "AwaitingReady", manifest } }, [
    { kind: "StartReadyTimer", operation, key: event.key, deadlineAt: event.now + readinessMillis }
  ])
}
export const requestReply = (state: OutputState, delayMillis: number): OutputTransition => {
  const selected = state.selected
  if (selected === null || selected.phase !== "Playing" || selected.publicationOperation === null)
    return unchangedOutput(state)
  const operation = state.nextOperation
  return outputResult(
    reserveOutput(state, {
      kind: "ReplyRead",
      operation,
      key: selected.key,
      parentOperation: selected.publicationOperation,
      status: "Reserved"
    }),
    [{ kind: "ReadReply", operation, key: selected.key, delayMillis }]
  )
}
const readyTarget = (state: OutputState, input: Extract<OutputEvent, { kind: "Ready" }>["input"]) => {
  const selected = state.selected
  return selected !== null &&
    selected.phase === "AwaitingReady" &&
    input.responseId === selected.key.ticket.responseId &&
    input.outputEpoch === selected.key.outputEpoch
    ? selected
    : null
}
const cancelReadyTimer = (state: OutputState, key: OutputKey): OutputTransition => {
  const timer = state.obligations.find((entry) => entry.kind === "ReadyTimer" && sameOutputKey(entry.key, key))
  return timer?.kind !== "ReadyTimer"
    ? outputResult(state)
    : outputResult(replaceOutputOperation(state, { ...timer, status: "Cancelling" }), [
        { kind: "Cancel", operation: timer.operation }
      ])
}
const ready = (state: OutputState, event: Extract<OutputEvent, { kind: "Ready" }>): OutputTransition => {
  const input = event.input
  const selected = readyTarget(state, input)
  if (selected === null) return unchangedOutput(state)
  if (selected.manifest?.trackSid !== input.trackSid)
    return {
      ...unchangedOutput(state),
      decision: {
        kind: "Rejected",
        error: { code: "StaleOutput", message: "Ready acknowledgement must identify its exact publication" }
      }
    }
  const cancelled = cancelReadyTimer(state, selected.key)
  const result = requestReply({ ...cancelled.state, selected: { ...selected, phase: "Playing" } }, 0)
  return { ...result, commands: [...cancelled.commands, ...result.commands] }
}

const deadline = (state: OutputState, event: Extract<OutputEvent, { kind: "ReadyDeadline" }>): OutputTransition => {
  const entry = keyedOutputOperation(state, event)
  if (entry?.kind !== "ReadyTimer") return unchangedOutput(state)
  const retired = removeOutputOperation(state, event.operation)
  return entry.status === "Cancelling" || liveOutput(retired, event.key)?.phase !== "AwaitingReady"
    ? outputResult(retired)
    : failOutput(retired, {
        code: "AudioUnavailable",
        reason: "ReadinessDeadline",
        message: "Reply audio readiness exceeded its deadline"
      })
}
const publicationFailed = (
  state: OutputState,
  event: Extract<OutputEvent, { kind: "PublicationFailed" }>
): OutputTransition => {
  const entry = keyedOutputOperation(state, event)
  if (entry?.kind !== "Publication") return unchangedOutput(state)
  const retired = removeOutputOperation(state, event.operation)
  return liveOutput(retired, event.key) === null ? outputResult(retired) : failOutput(retired, event.error)
}
export const transitionOutputPublication = (
  state: OutputState,
  event: Extract<OutputEvent, { kind: "PublicationOpened" | "PublicationFailed" | "Ready" | "ReadyDeadline" }>,
  context: OutputContext
): OutputTransition => {
  switch (event.kind) {
    case "PublicationOpened":
      return opened(state, event, context)
    case "Ready":
      return ready(state, event)
    case "ReadyDeadline":
      return deadline(state, event)
    case "PublicationFailed":
      return publicationFailed(state, event)
  }
}
