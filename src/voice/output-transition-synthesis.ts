import type { OutputState, OutputContext, OutputSelection } from "./output-state.ts"
import type { OutputEvent, OutputTransition } from "./output-events.ts"
import { failOutput } from "./output-transition-control.ts"
import { advancePhrase } from "./output-transition-phrases.ts"
import {
  keyedOutputOperation,
  outputResult,
  liveOutput,
  removeOutputOperation,
  reserveOutput,
  unchangedOutput
} from "./output-transition-result.ts"
const releasePacket = (
  state: OutputState,
  event: Extract<OutputEvent, { kind: "SynthesisPacket" }>
): OutputTransition =>
  outputResult(
    state,
    event.packet.kind === "Chunk" ? [{ kind: "ReleasePayload", payloadId: event.packet.payloadId }] : []
  )
const packetFailure = (
  state: OutputState,
  event: Extract<OutputEvent, { kind: "SynthesisPacket" }>,
  message: string
): OutputTransition => {
  const result = failOutput(state, { code: "AudioUnavailable", message })
  return { ...result, commands: [...releasePacket(state, event).commands, ...result.commands] }
}
const packet = (
  state: OutputState,
  event: Extract<OutputEvent, { kind: "SynthesisPacket" }>,
  context: OutputContext
): OutputTransition => {
  const entry = keyedOutputOperation(state, event)
  if (entry?.kind !== "Synthesis" || entry.status === "Cancelling") return releasePacket(state, event)
  const selected = liveOutput(state, event.key)
  if (selected === null || selected.phraseOperation !== event.operation) return releasePacket(state, event)
  return acceptPacket(state, selected, event, context)
}
const acceptPacket = (
  state: OutputState,
  selected: OutputSelection,
  event: Extract<OutputEvent, { kind: "SynthesisPacket" }>,
  context: OutputContext
): OutputTransition => {
  const valid =
    !selected.phraseCompleted &&
    event.responseId.toLowerCase() === event.key.ticket.responseId &&
    event.phraseId.toLowerCase() === selected.phraseId &&
    event.sequence === selected.nextPacketSequence
  if (!valid) return packetFailure(state, event, "Invalid synthesis identity or sequence")
  if (event.packet.kind === "Completed")
    return outputResult({ ...state, selected: { ...selected, phraseCompleted: true } })
  const frames = selected.phraseAudioFrames + event.packet.sampleFrames
  if (frames > context.maxAudioFrames) return packetFailure(state, event, "Phrase audio exceeds capacity")
  return capturePacket(
    {
      ...state,
      selected: { ...selected, nextPacketSequence: selected.nextPacketSequence + 1, phraseAudioFrames: frames }
    },
    event
  )
}
const capturePacket = (
  state: OutputState,
  event: Extract<OutputEvent, { kind: "SynthesisPacket" }>
): OutputTransition => {
  const selected = state.selected
  if (selected === null || selected.publicationOperation === null || event.packet.kind !== "Chunk")
    return releasePacket(state, event)
  const operation = state.nextOperation
  const reserved = reserveOutput(state, {
    kind: "Capture",
    operation,
    key: event.key,
    parentOperation: selected.publicationOperation,
    payloadId: event.packet.payloadId,
    status: "Reserved"
  })
  return outputResult(reserved, [
    {
      kind: "Capture",
      operation,
      key: event.key,
      publicationOperation: selected.publicationOperation,
      payloadId: event.packet.payloadId
    }
  ])
}
const captured = (state: OutputState, event: Extract<OutputEvent, { kind: "CaptureFinished" }>): OutputTransition => {
  const entry = keyedOutputOperation(state, event)
  if (entry?.kind !== "Capture") return unchangedOutput(state)
  const retired = removeOutputOperation(state, event.operation)
  const applied = liveOutput(retired, event.key) !== null && entry.status !== "Cancelling"
  const result =
    !applied || event.outcome.kind === "Success"
      ? outputResult(retired)
      : failOutput(
          retired,
          event.outcome.kind === "Failure"
            ? event.outcome.error
            : { code: "AudioUnavailable", message: "Reply audio capture was interrupted" }
        )
  return { ...result, commands: [{ kind: "ReleasePayload", payloadId: entry.payloadId }, ...result.commands] }
}
const settled = (
  state: OutputState,
  event: Extract<OutputEvent, { kind: "SynthesisSettled" }>,
  context: OutputContext
): OutputTransition => {
  const entry = keyedOutputOperation(state, event)
  if (entry?.kind !== "Synthesis") return unchangedOutput(state)
  const retired = removeOutputOperation(state, event.operation)
  const selected = liveOutput(retired, event.key)
  if (selected === null || entry.status === "Cancelling" || selected.phraseOperation !== event.operation)
    return outputResult(retired)
  return finishPhrase(retired, selected, event, context)
}
const finishPhrase = (
  state: OutputState,
  selected: OutputSelection,
  event: Extract<OutputEvent, { kind: "SynthesisSettled" }>,
  context: OutputContext
): OutputTransition => {
  if (event.outcome.kind === "Failure") return failOutput(state, event.outcome.error)
  if (event.outcome.kind !== "Success" || !selected.phraseCompleted || selected.nextPacketSequence === 0)
    return failOutput(state, { code: "AudioUnavailable", message: "Synthesis lacks complete audio" })
  return advancePhrase(
    { ...state, selected: { ...selected, phraseOperation: null, phraseId: null } },
    event.nextPhraseId,
    context
  )
}
export const transitionOutputSynthesis = (
  state: OutputState,
  event: Extract<OutputEvent, { kind: "SynthesisPacket" | "CaptureFinished" | "SynthesisSettled" }>,
  context: OutputContext
): OutputTransition => {
  switch (event.kind) {
    case "SynthesisPacket":
      return packet(state, event, context)
    case "CaptureFinished":
      return captured(state, event)
    case "SynthesisSettled":
      return settled(state, event, context)
  }
}
