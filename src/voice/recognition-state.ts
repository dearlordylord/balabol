import type { HashMap } from "effect"
import type { LanguageSpan } from "../language/index.ts"
import type { RecognitionEvent } from "../speech-recognition/index.ts"
export const maximumRecognitionChunks = 30
export const maximumRecognitionJobs = 2
/** Immutable coordinates into adapter-owned PCM; never a writable sample buffer. */
export interface PcmSlice {
  readonly fragmentId: string
  readonly offsetSamples: number
  readonly sampleFrames: number
}
export type RecognitionFinal = Extract<RecognitionEvent, { kind: "Final" }>
export interface ReadyRecognition {
  readonly turnId: string
  readonly generation: number
  readonly fenceId: string
  readonly text: string
  readonly languageSpans: readonly LanguageSpan[]
  readonly detectedLanguage: string | null
}
export type RecognitionSegment =
  | { readonly kind: "Idle"; readonly slices: readonly PcmSlice[]; readonly samples: number }
  | { readonly kind: "Active"; readonly slices: readonly PcmSlice[]; readonly samples: number; readonly quiet: number }
export interface RecognitionChunk {
  readonly turnId: string
  readonly generation: number
  readonly index: number
  readonly requestId: string
  readonly slices: readonly PcmSlice[]
  readonly sampleFrames: number
}
export interface RecognitionJob extends RecognitionChunk {
  readonly streaming?: "Open" | "Sealed"
  readonly operation: number
  readonly status: "Reserved" | "Running" | "Cancelling"
  readonly candidate: RecognitionFinal | null
}
export interface RecognitionTurn {
  readonly id: string
  readonly generation: number
  readonly fenceId: string
  readonly ended: boolean
  readonly chunks: number
  readonly results: readonly { readonly index: number; readonly final: RecognitionFinal }[]
  readonly textLength: number
  readonly spanCount: number
  readonly ready: ReadyRecognition | null
}
export interface RecognitionState {
  readonly streaming?: true
  readonly generation: number
  readonly segment: RecognitionSegment
  readonly turn: RecognitionTurn | null
  readonly suppressed: boolean
  readonly queue: readonly RecognitionChunk[]
  /** Reserved and cancelling work occupies its physical slot until matching settlement. */
  readonly jobs: readonly RecognitionJob[]
  readonly nextOperation: number
  readonly fragmentOwners: HashMap.HashMap<string, number>
}
