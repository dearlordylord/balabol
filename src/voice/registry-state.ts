import type { SessionRetention } from "./session-port.ts"
import type { StartVoiceRequest } from "./recovery-contracts.ts"
import { failed } from "./contracts.ts"
import type { VoiceFailed } from "./contracts.ts"
const maximumSessions = 2
export interface RegistryRecord {
  readonly retentionRevision: number
  readonly sessionId: string
  readonly startRequestId: string
  readonly initialMuted: boolean
  readonly phase: "reserved" | "ready"
  readonly status: "active" | "closing" | "ended"
  readonly pendingAdmissions: number
  readonly releaseComplete: boolean
}
export interface RegistryState {
  readonly retired: boolean
  readonly records: readonly RegistryRecord[]
}
type Reservation =
  | { readonly kind: "Existing"; readonly sessionId: string }
  | { readonly kind: "Rejected"; readonly error: VoiceFailed }
  | { readonly kind: "Reserved"; readonly evicted: string | undefined }
export const reserveSession = (
  state: RegistryState,
  request: StartVoiceRequest,
  sessionId: string
): { readonly state: RegistryState; readonly result: Reservation } => {
  if (state.retired)
    return { state, result: { kind: "Rejected", error: failed("VoiceBusy", "Voice is shutting down") } }
  const prior = state.records.find((record) => record.startRequestId === request.startRequestId)
  if (prior !== undefined) return { state, result: existingReservation(prior, request.muted) }
  if (state.records.some((record) => record.status !== "ended" || !record.releaseComplete))
    return { state, result: { kind: "Rejected", error: failed("VoiceBusy", "A voice session is already active") } }
  const evicted = state.records.length >= maximumSessions ? state.records.find(evictable)?.sessionId : undefined
  if (state.records.length >= maximumSessions && evicted === undefined)
    return { state, result: { kind: "Rejected", error: failed("VoiceBusy", "Previous acceptance is still pending") } }
  return {
    state: {
      ...state,
      records: [
        ...state.records.filter((record) => record.sessionId !== evicted),
        {
          sessionId,
          startRequestId: request.startRequestId,
          initialMuted: request.muted,
          phase: "reserved",
          status: "active",
          pendingAdmissions: 0,
          releaseComplete: false,
          retentionRevision: -1
        }
      ]
    },
    result: { kind: "Reserved", evicted }
  }
}
const evictable = (record: RegistryRecord) =>
  record.phase === "ready" && record.status === "ended" && record.releaseComplete && record.pendingAdmissions === 0
const existingReservation = (record: RegistryRecord, muted: boolean): Reservation => {
  if (record.initialMuted !== muted)
    return { kind: "Rejected", error: failed("StartConflict", "Voice start identity has another initial mute intent") }
  if (record.status !== "active")
    return { kind: "Rejected", error: failed("StartExpired", "The original voice session has ended") }
  return { kind: "Existing", sessionId: record.sessionId }
}
export type RegistryEvent =
  | { readonly kind: "Retired" }
  | { readonly kind: "Ready"; readonly sessionId: string }
  | { readonly kind: "Failed"; readonly sessionId: string }
  | { readonly kind: "Retention"; readonly fact: SessionRetention }
export const registryTransition = (state: RegistryState, event: RegistryEvent): RegistryState => {
  if (event.kind === "Retired") return { ...state, retired: true }
  if (event.kind === "Failed")
    return { ...state, records: state.records.filter((record) => record.sessionId !== event.sessionId) }
  const id = event.kind === "Retention" ? event.fact.sessionId : event.sessionId
  return {
    ...state,
    records: state.records.map((record) => {
      if (record.sessionId !== id) return record
      if (event.kind === "Ready") return { ...record, phase: "ready" }
      if (event.fact.revision <= record.retentionRevision) return record
      return { ...record, ...event.fact, retentionRevision: event.fact.revision }
    })
  }
}
