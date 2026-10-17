import { closeAttempt, unregisterAttempt } from "./output-transition-cleanup.ts"
import type { OutputState, OutputObligation, OutputKey } from "./output-state.ts"
import type { OutputCommand, OutputTransition } from "./output-events.ts"
import {
  outputResult,
  reserveOutput,
  outputTerminal,
  sameOutputKey,
  continueOutput,
  replaceOutputOperation
} from "./output-transition-result.ts"
export const mediaObligation = (entry: OutputObligation): boolean =>
  entry.kind === "Publication" ||
  entry.kind === "Synthesis" ||
  entry.kind === "Capture" ||
  entry.kind === "ReadyTimer" ||
  entry.kind === "Drain" ||
  entry.kind === "ReplyRead"
const cancelled = (entry: OutputObligation, key: OutputKey | null): boolean =>
  mediaObligation(entry) && "key" in entry && (key === null || sameOutputKey(entry.key, key))
interface ResourceStep {
  readonly obligations: readonly OutputObligation[]
  readonly commands: readonly OutputCommand[]
}
const cancellation = (entry: OutputObligation, key: OutputKey | null): ResourceStep => {
  if (!cancelled(entry, key)) return { obligations: [entry], commands: [] }
  if (entry.kind === "Publication")
    return { obligations: [entry], commands: [{ kind: "RevokePublication", publicationOperation: entry.operation }] }
  if (entry.kind === "CloseAttempt" || entry.kind === "UnregisterAttempt") return { obligations: [entry], commands: [] }
  if (!("parentOperation" in entry) || entry.status === "Cancelling") return { obligations: [entry], commands: [] }
  return {
    obligations: [{ ...entry, status: "Cancelling" }],
    commands: [{ kind: "Cancel", operation: entry.operation }]
  }
}
const transformResources = (
  state: OutputState,
  transform: (entry: OutputObligation) => ResourceStep
): OutputTransition => {
  const result = state.obligations.reduce<ResourceStep>(
    (step, entry) => {
      const next = transform(entry)
      return { obligations: [...step.obligations, ...next.obligations], commands: [...step.commands, ...next.commands] }
    },
    { obligations: [], commands: [] }
  )
  return outputResult({ ...state, obligations: result.obligations }, result.commands)
}
export const cancelOutputWork = (state: OutputState, key: OutputKey | null): OutputTransition =>
  transformResources(state, (entry) => cancellation(entry, key))
const closure = (state: OutputState, entry: OutputObligation): OutputTransition => {
  if (entry.kind !== "Publication" || entry.status !== "Open") return outputResult(state)
  const selected = state.selected
  const active =
    !state.retired && selected !== null && !outputTerminal(selected.phase) && sameOutputKey(selected.key, entry.key)
  const children = state.obligations.some(
    (child) => "parentOperation" in child && child.parentOperation === entry.operation
  )
  if (active || children) return outputResult(state)
  const releasing: OutputObligation = { ...entry, status: "Releasing" }
  return closeAttempt(replaceOutputOperation(state, releasing), releasing, 0)
}
const closeUnused = (state: OutputState): OutputTransition =>
  state.obligations.reduce(
    (step, entry) => continueOutput(step, (current) => closure(current, entry)),
    outputResult(state)
  )
const openSelected = (state: OutputState): OutputTransition => {
  const selected = state.selected
  if (
    state.retired ||
    selected === null ||
    selected.phase !== "Preparing" ||
    selected.publicationOperation !== null ||
    state.obligations.some(mediaObligation)
  )
    return outputResult(state)
  const operation = state.nextOperation
  const reserved = reserveOutput(state, { kind: "Publication", operation, key: selected.key, status: "Acquiring" })
  return outputResult({ ...reserved, selected: { ...selected, publicationOperation: operation } }, [
    { kind: "OpenPublication", operation, key: selected.key }
  ])
}
const unregister = (state: OutputState): OutputTransition => {
  if (
    !state.retired ||
    state.registrationId === null ||
    state.obligations.some((entry) => entry.kind === "Unregistration")
  )
    return outputResult(state)
  const parent: OutputObligation = {
    kind: "Unregistration",
    operation: state.nextOperation,
    registrationId: state.registrationId,
    status: "Reserved"
  }
  return unregisterAttempt(reserveOutput(state, parent), parent, 0)
}

export const reconcileOutput = (state: OutputState): OutputTransition => {
  const closed = closeUnused(state)
  const opened = openSelected(closed.state)
  const detached = unregister(opened.state)
  return outputResult(detached.state, [...closed.commands, ...opened.commands, ...detached.commands])
}
