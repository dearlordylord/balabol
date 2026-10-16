import core, { type Admission, type AdmissionEvent, type Command } from "./admission-core/index.ts"
import type { InputReservation, InputIntent, InputSource, SpeechFence } from "./admission-contracts.ts"
import { maximumPendingAdmissions } from "./admission-contracts.ts"
import { ReplyBusy } from "./contracts.ts"
import { maximumToken } from "./admission-api.ts"
import type { Message, SendMessage } from "./contracts.ts"

export type Entry = {
  readonly core: Admission
  readonly prerequisites: readonly bigint[]
  readonly result: "Pending" | "Failed" | "Acknowledged"
  readonly execution: Extract<Command, { $: "RecordSuperseded" | "StartResponse" }> | undefined
  readonly message: SendMessage
  readonly source: InputSource | undefined
  readonly receipt: Message | undefined
  readonly classification: "Checking" | "Fresh" | "Existing"
  readonly submitted: boolean
  readonly originSequence: number
  readonly currentSequence: number
  readonly originRevision: bigint
}
type Source = {
  readonly capability: InputSource
  readonly sequence: number
  readonly revision: bigint
  readonly acknowledgements: readonly {
    readonly fenceId: string
    readonly sequence: number
    readonly revision: bigint
  }[]
}
export type AdmissionState = {
  readonly revision: bigint
  readonly nextIdentity: bigint
  readonly entries: readonly Entry[]
  readonly sources: readonly Source[]
  readonly revocations: readonly {
    readonly command: Extract<Command, { $: "RevokeStart" }>
    readonly failed: boolean
  }[]
}
export const emptyAdmission: AdmissionState = {
  revision: 0n,
  nextIdentity: 1n,
  entries: [],
  sources: [],
  revocations: []
}
export const reservationOf = (entry: Entry): InputReservation => ({
  operationId: entry.core.operation,
  deliveryId: entry.message.deliveryId
})
export const findEntry = (state: AdmissionState, reservation: InputReservation) =>
  state.entries.find(
    (entry) => entry.core.operation === reservation.operationId && entry.message.deliveryId === reservation.deliveryId
  )
export const sourceOf = (state: AdmissionState, capability: InputSource) =>
  state.sources.find((source) => source.capability === capability)
export const replaceEntry = (state: AdmissionState, next: Entry): AdmissionState => ({
  ...state,
  entries: state.entries.map((entry) => (entry.core.operation === next.core.operation ? next : entry))
})
export const applyEvent = (
  state: AdmissionState,
  entry: Entry,
  event: AdmissionEvent
): { readonly state: AdmissionState; readonly command: Command } => {
  const decision = core.transition(entry.core, event)
  return { state: replaceEntry(state, { ...entry, core: decision.state }), command: decision.command }
}
export const openSource = (state: AdmissionState) => ({
  state: {
    ...state,
    nextIdentity: state.nextIdentity + 1n,
    sources: [
      ...state.sources,
      { capability: state.nextIdentity, sequence: 0, revision: state.revision, acknowledgements: [] }
    ]
  },
  capability: state.nextIdentity
})
export const closeSource = (state: AdmissionState, capability: InputSource): AdmissionState => ({
  ...state,
  sources: state.sources.filter((source) => source.capability !== capability),
  entries: state.entries.map((entry) =>
    entry.source === capability ? { ...entry, core: core.transition(entry.core, { $: "CaptureClosed" }).state } : entry
  )
})
const inputSource = (state: AdmissionState, intent: InputIntent) =>
  intent.source === undefined ? undefined : sourceOf(state, intent.source.capability)
export const registerEntry = (
  state: AdmissionState,
  intent: InputIntent
): { readonly state: AdmissionState; readonly entry: Entry } => {
  const source = inputSource(state, intent)
  const originSequence = intent.source?.sequence ?? 0
  const currentSequence = source?.sequence ?? 0
  const originRevision = source === undefined ? state.revision : source.revision
  const entry: Entry = {
    core: core.initialize(state.nextIdentity, state.nextIdentity, {
      $: "OriginClock",
      sourceSequence: BigInt(originSequence),
      currentSourceSequence: BigInt(currentSequence),
      originRevision,
      currentRevision: state.revision
    }),
    prerequisites: [],
    result: "Pending",
    execution: undefined,
    message: structuredClone(intent.message),
    source: source === undefined ? undefined : source.capability,
    receipt: undefined,
    classification: "Checking",
    submitted: false,
    originSequence,
    currentSequence,
    originRevision
  }
  return { state: { ...state, nextIdentity: state.nextIdentity + 1n, entries: [...state.entries, entry] }, entry }
}
export const classifyEntry = (state: AdmissionState, entry: Entry) => {
  const revision = entry.source === undefined ? state.revision + 1n : state.revision
  const decisions =
    entry.source === undefined
      ? state.entries
          .filter((candidate) => candidate !== entry)
          .map((candidate) => ({ entry: candidate, decision: core.transition(candidate.core, { $: "Fence" }) }))
      : []
  const originRevision = entry.source === undefined ? revision : entry.originRevision
  const next: Entry = {
    ...entry,
    classification: "Fresh",
    prerequisites: [
      ...new Set([
        ...state.revocations.map((item) => item.command.operation),
        ...decisions.flatMap(({ decision }) =>
          decision.command.$ === "RevokeStart" ? [decision.command.operation] : []
        )
      ])
    ],
    core: core.initialize(entry.core.operation, entry.core.payload, {
      $: "OriginClock",
      sourceSequence: BigInt(entry.originSequence),
      currentSourceSequence: BigInt(entry.currentSequence),
      originRevision,
      currentRevision: revision
    })
  }
  const entries = state.entries.map((candidate) => {
    if (candidate === entry) return next
    const decision = decisions.find((item) => item.entry === candidate)?.decision
    return decision === undefined ? candidate : { ...candidate, core: decision.state }
  })
  return {
    state: { ...state, revision, entries },
    commands: decisions.map(({ decision }) => decision.command),
    entry: next
  }
}

export const applyFence = (
  state: AdmissionState,
  fence: SpeechFence
): { readonly state: AdmissionState; readonly commands: readonly Command[]; readonly revision: bigint } => {
  const revision = state.revision + 1n
  const decisions = state.entries.map((entry) => ({ entry, decision: core.transition(entry.core, { $: "Fence" }) }))
  return {
    state: {
      ...state,
      revision,
      entries: decisions.map(({ decision, entry }) => ({ ...entry, core: decision.state })),
      sources: state.sources.map((source) =>
        source.capability === fence.capability
          ? {
              ...source,
              sequence: fence.sequence,
              revision,
              acknowledgements: [
                ...source.acknowledgements,
                { fenceId: fence.fenceId, sequence: fence.sequence, revision }
              ]
            }
          : source
      )
    },
    commands: decisions.map(({ decision }) => decision.command),
    revision
  }
}

export const changeSource = (state: AdmissionState, capability: InputSource | undefined) => {
  if (capability === undefined) {
    if (state.nextIdentity > maximumToken) return undefined
    const opened = openSource(state)
    return { state: opened.state, outcome: { kind: "Source" as const, capability: opened.capability } }
  }
  return sourceOf(state, capability) === undefined
    ? undefined
    : { state: closeSource(state, capability), outcome: { kind: "Done" as const } }
}

export const markResult = (state: AdmissionState, operation: bigint, result: Entry["result"]): AdmissionState => ({
  ...state,
  entries: state.entries.map((entry) =>
    entry.core.operation === operation
      ? {
          ...entry,
          result,
          execution: result === "Acknowledged" ? undefined : entry.execution,
          prerequisites: result === "Acknowledged" ? [] : entry.prerequisites
        }
      : entry
  )
})
export const retainExecution = (
  state: AdmissionState,
  command: Extract<Command, { $: "RecordSuperseded" | "StartResponse" }>
): AdmissionState => ({
  ...state,
  entries: state.entries.map((entry) =>
    entry.core.operation === command.operation ? { ...entry, execution: command } : entry
  )
})
export const retainRevocation = (
  state: AdmissionState,
  command: Extract<Command, { $: "RevokeStart" }>
): AdmissionState => ({
  ...state,
  revocations: [
    ...state.revocations.filter((item) => item.command.operation !== command.operation),
    { command, failed: false }
  ]
})
export const failRevocation = (state: AdmissionState, operation: bigint): AdmissionState => ({
  ...state,
  revocations: state.revocations.map((item) =>
    item.command.operation === operation ? { ...item, failed: true } : item
  )
})
export const settleRevocation = (state: AdmissionState, operation: bigint): AdmissionState => ({
  ...state,
  revocations: state.revocations.filter((item) => item.command.operation !== operation)
})
const retainEntry = (state: AdmissionState, entry: Entry) => {
  if (entry.result === "Pending" || entry.core.phase.$ === "Recoverable" || entry.execution !== undefined) return true
  if (state.revocations.some((item) => item.command.operation === entry.core.operation)) return true
  return entry.core.phase.$ === "Started" && entry.core.eligibility.$ === "Eligible"
}
export const retireSettled = (state: AdmissionState): AdmissionState => ({
  ...state,
  entries: state.entries.filter((entry) => retainEntry(state, entry))
})
export const reservationFailure = (state: AdmissionState) => {
  if (
    state.entries.some(
      (entry) => entry.core.phase.$ === "Recoverable" || (entry.result === "Failed" && entry.execution !== undefined)
    )
  )
    return new ReplyBusy({ message: "Resolve the existing uncertain input before submitting a new delivery identity" })
  return state.entries.filter((entry) => entry.result === "Pending").length >= maximumPendingAdmissions
    ? new ReplyBusy({ message: "Conversation input reservations are full; retry this delivery identity later" })
    : undefined
}

/** Core commands are synchronous owner decisions; a missing target is a broken invariant, not a stale external event. */
export const requireEntry = (state: AdmissionState, operation: bigint): Entry => {
  const entry = state.entries.find((candidate) => candidate.core.operation === operation)
  if (entry === undefined) throw new Error("Admission command lost its correlated input")
  return entry
}
export const requireAccepted = (state: AdmissionState, operation: bigint) => {
  const entry = requireEntry(state, operation)
  if (entry.receipt === undefined) throw new Error("Admission acknowledgement lost its durable receipt")
  return entry.receipt
}
