import type { DeliveryTicket, ResponseTarget } from "../conversation/index.ts"
import type { AudioManifest, VoiceOutput } from "./contracts.ts"
import type { Phrase, PhraseState } from "./phrases.ts"
export interface OutputKey {
  readonly ticket: DeliveryTicket
  readonly outputEpoch: string
}
export interface OutputError {
  readonly code: string
  readonly message: string
}
export interface OutputSelection {
  readonly key: OutputKey
  readonly phase:
    | "Preparing"
    | "AwaitingReady"
    | "Playing"
    | "Draining"
    | "Settling"
    | "Delivered"
    | "Interrupted"
    | "Failed"
  readonly manifest: AudioManifest | null
  readonly error: OutputError | null
  readonly phrases: PhraseState
  readonly replyComplete: boolean
  readonly publicationOperation: number | null
  readonly phraseOperation: number | null
  readonly phraseId: string | null
  readonly nextPacketSequence: number
  readonly phraseAudioFrames: number
  readonly phraseCompleted: boolean
}
export type OperationStatus = "Reserved" | "Running" | "Cancelling"
export type OutputObligation =
  | { readonly kind: "Registration"; readonly operation: number; readonly status: OperationStatus }
  | {
      readonly kind: "Publication"
      readonly operation: number
      readonly key: OutputKey
      readonly status: "Reserved" | "Acquiring" | "Open" | "Releasing"
      readonly releaseError?: OutputError
    }
  | {
      readonly kind: "ReplyRead" | "Drain" | "ReadyTimer"
      readonly operation: number
      readonly key: OutputKey
      readonly parentOperation: number
      readonly status: OperationStatus
    }
  | {
      readonly kind: "Synthesis"
      readonly operation: number
      readonly key: OutputKey
      readonly parentOperation: number
      readonly phraseId: string
      readonly phrase: Phrase
      readonly status: OperationStatus
    }
  | {
      readonly kind: "Capture"
      readonly operation: number
      readonly key: OutputKey
      readonly parentOperation: number
      readonly payloadId: string
      readonly status: OperationStatus
    }
  | {
      readonly kind: "Settlement"
      readonly operation: number
      readonly key: OutputKey
      readonly outcome: "Completed" | "Failed"
      readonly error: OutputError | null
      readonly status: "Reserved" | "Running" | "Rejected"
    }
  | {
      readonly kind: "CloseAttempt"
      readonly operation: number
      readonly parentOperation: number
      readonly key: OutputKey
      readonly status: "Reserved" | "Running"
    }
  | {
      readonly kind: "UnregisterAttempt"
      readonly operation: number
      readonly parentOperation: number
      readonly registrationId: string
      readonly status: "Reserved" | "Running"
    }
  | {
      readonly kind: "Unregistration"
      readonly operation: number
      readonly registrationId: string
      readonly status: "Reserved" | "Running" | "Rejected"
      readonly releaseError?: OutputError
    }
  | {
      readonly kind: "InterruptResponse"
      readonly operation: number
      readonly target: ResponseTarget
      readonly status: "Reserved" | "Running" | "Rejected"
    }
export interface OutputState {
  readonly retired: boolean
  readonly registrationId: string | null
  readonly lastUpdateSequence: number
  readonly selected: OutputSelection | null
  readonly suppressedAdmissions: readonly SuppressedAdmission[]
  readonly latestSpeechSequence: number
  readonly obligations: readonly OutputObligation[]
  readonly nextOperation: number
}
export interface SuppressedAdmission {
  readonly inputDeliveryId: string
  readonly fenceId: string
  readonly sequence: number
  readonly admissionFinished: boolean
  readonly fenceStatus: "Pending" | "Applied" | "Rejected"
}
export interface OutputContext {
  readonly sessionId: string
  readonly languages: readonly string[]
  readonly maxAudioFrames: number
  readonly completionMillis: number
}
export type OutputDecision =
  | { readonly kind: "Ignored" }
  | { readonly kind: "Applied"; readonly operation?: number }
  | { readonly kind: "Rejected"; readonly error: OutputError }
const projectedPhase = (phase: Exclude<OutputSelection["phase"], "Failed" | "Interrupted">) =>
  phase === "Draining" || phase === "Settling" ? "Playing" : phase
export const outputProjection = (state: OutputState): VoiceOutput | null => {
  const selected = state.selected
  if (selected === null) return null
  const fields = {
    responseId: selected.key.ticket.responseId,
    inputDeliveryId: selected.key.ticket.inputDeliveryId,
    outputEpoch: selected.key.outputEpoch
  }
  if (selected.phase === "Failed")
    return {
      ...fields,
      status: "Failed",
      manifest: selected.manifest,
      error: selected.error ?? { code: "AudioUnavailable", message: "Reply audio failed" }
    }
  if (selected.phase === "Interrupted")
    return { ...fields, status: "Interrupted", manifest: selected.manifest, error: null }
  if (selected.manifest === null) return { ...fields, status: "Preparing", manifest: null, error: null }
  const status = projectedPhase(selected.phase)
  if (status === "Preparing") return { ...fields, status: "Preparing", manifest: null, error: null }
  return { ...fields, status, manifest: selected.manifest, error: null }
}
