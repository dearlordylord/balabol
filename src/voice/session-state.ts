import type { RecognitionState } from "./recognition-state.ts"
import type { OutputState, OutputContext } from "./output-state.ts"
import { outputProjection } from "./output-state.ts"
import { initialOutput } from "./output-transition.ts"
import { initialRecognition, readyFinal } from "./recognition-transition.ts"
import type { Message } from "../conversation/index.ts"
import type { LanguageSpan } from "../language/index.ts"
import type { PendingVoiceInput, VoiceEvent, VoiceSnapshot } from "./contracts.ts"
export type SessionEventInput = VoiceEvent extends infer E
  ? E extends VoiceEvent
    ? Omit<E, "sequence" | "sessionId">
    : never
  : never
export interface SpeechPayload {
  readonly id: string
  readonly text: string
  readonly languageSpans: readonly LanguageSpan[]
  readonly detectedLanguage: string | null
}
export type SpeechFenceState =
  | { readonly fenceId: string; readonly generation: number; readonly sequence: number; readonly status: "Pending" }
  | {
      readonly fenceId: string
      readonly generation: number
      readonly sequence: number
      readonly status: "Applied"
      readonly revision: bigint
    }
  | {
      readonly fenceId: string
      readonly generation: number
      readonly sequence: number
      readonly status: "Rejected"
      readonly message: string
    }
export interface SessionState {
  readonly id: string
  readonly incarnation: string
  readonly phase: "starting" | "active" | "closing" | "ended"
  readonly muted: boolean
  readonly joined: boolean
  readonly generation: number
  /** Exact classification obligation; physical cancellation belongs to captureScope. */
  readonly classification: { readonly operation: number; readonly generation: number } | undefined
  readonly retiredTracks: readonly string[]
  readonly speechFences: readonly SpeechFenceState[]
  readonly recognition: RecognitionState
  readonly recognitionLanguages: readonly string[]
  readonly track: string | undefined
  readonly joinDeadlineAt: number
  readonly controlDeadlineAt: number
  readonly expiryTimer: { readonly operation: number; readonly deadlineAt: number } | null
  readonly nextExpiryOperation: number
  readonly speechRevision: number
  readonly sequence: number
  readonly events: readonly VoiceEvent[]
  readonly admitting: readonly string[]
  readonly unresolved: readonly SpeechPayload[]
  readonly finals: readonly PendingVoiceInput[]
  readonly audioFramesReceived: number
  readonly sampleFramesReceived: number
  readonly releasePending: readonly string[]
  readonly output: OutputState
  readonly outputContext: OutputContext
}
export const sessionJoinMillis = 10000
export const sessionControlMillis = 30000
export const sessionMaximumPending = 2
export const initialSession = (
  id: string,
  incarnation: string,
  muted: boolean,
  now: number,
  recognitionLanguages: readonly string[],
  outputContext: OutputContext
): SessionState => ({
  id,
  incarnation,
  phase: "starting",
  muted,
  joined: false,
  generation: 0,
  classification: undefined,
  retiredTracks: [],
  speechFences: [],
  recognition: initialRecognition(0),
  recognitionLanguages,
  track: undefined,
  joinDeadlineAt: now + sessionJoinMillis,
  controlDeadlineAt: now + sessionControlMillis,
  expiryTimer: null,
  nextExpiryOperation: 1,
  speechRevision: 0,
  sequence: 0,
  events: [],
  admitting: [],
  unresolved: [],
  finals: [],
  audioFramesReceived: 0,
  sampleFramesReceived: 0,
  releasePending: [],
  output: initialOutput(),
  outputContext
})
export const pendingCount = (state: SessionState) => {
  const ready = readyFinal(state.recognition)
  return new Set([...state.admitting, ...state.unresolved.map((x) => x.id), ...(ready === null ? [] : [ready.turnId])])
    .size
}
export const sessionSnapshot = (state: SessionState, after: number): VoiceSnapshot => ({
  backendIncarnationId: state.incarnation,
  sessionId: state.id,
  status: state.phase === "active" || state.phase === "starting" ? "active" : "ended",
  muted: state.muted,
  controlDeadlineAt: state.controlDeadlineAt,
  sequence: state.sequence,
  events: state.events.filter((event) => event.sequence > after),
  firstSequence: state.events[0]?.sequence ?? state.sequence + 1,
  audioFramesReceived: state.audioFramesReceived,
  sampleFramesReceived: state.sampleFramesReceived,
  pending: state.finals,
  output: outputProjection(state.output),
  nextAfter: state.sequence
})
export const finalInput = (
  state: SessionState,
  input: SpeechPayload,
  receipt: Message | null,
  error: PendingVoiceInput["error"]
): PendingVoiceInput => ({
  backendIncarnationId: state.incarnation,
  utteranceId: input.id,
  deliveryId: input.id,
  text: input.text,
  languageSpans: input.languageSpans,
  detectedLanguage: input.detectedLanguage,
  receipt,
  error
})
export const replaceFinal = (state: SessionState, input: PendingVoiceInput) => {
  const finals = [...state.finals.filter((item) => item.utteranceId !== input.utteranceId), input]
  if (finals.length <= sessionMaximumPending) return finals
  const accepted = finals.find((item) => item.receipt !== null)
  return accepted === undefined ? finals : finals.filter((item) => item !== accepted)
}
