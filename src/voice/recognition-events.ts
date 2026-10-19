import type { RecognitionEvent, RecognitionFailureReason } from "../speech-recognition/index.ts"
import type { RecognitionJob } from "./recognition-state.ts"
export interface RecognitionError {
  readonly code: string
  readonly message: string
  readonly reason?: typeof RecognitionFailureReason.Type
}
/** Each classified window is at most 512 samples, so it can create at most one
 * new turn and one chunk. Identity proposals are generated outside the core. */
export type RecognitionInput =
  | {
      readonly kind: "Window"
      readonly generation: number
      readonly fragmentId: string
      readonly sampleFrames: number
      readonly speech: boolean
      readonly turnId: string
      readonly fenceId: string
      readonly requestId: string
    }
  | { readonly kind: "JobStarted"; readonly operation: number; readonly generation: number }
  | {
      readonly kind: "Packet"
      readonly operation: number
      readonly generation: number
      readonly event: RecognitionEvent
    }
  | {
      readonly kind: "Invalid"
      readonly operation: number
      readonly generation: number
      readonly error: RecognitionError
    }
  | {
      readonly kind: "Settled"
      readonly operation: number
      readonly generation: number
      readonly outcome:
        | { readonly kind: "Success" }
        | { readonly kind: "Failure"; readonly error: RecognitionError }
        | { readonly kind: "Defect"; readonly error: RecognitionError }
        | { readonly kind: "Interrupted" }
    }
  | { readonly kind: "CaptureBoundary"; readonly generation: number; readonly requestId: string }
  | { readonly kind: "Reset"; readonly generation: number }
  | { readonly kind: "Gap"; readonly generation: number }
  | { readonly kind: "Handed"; readonly generation: number; readonly turnId: string }
  | {
      readonly kind: "RejectTurn"
      readonly generation: number
      readonly turnId: string
      readonly error: RecognitionError
    }
export type RecognitionCommand =
  | { readonly kind: "Recognize"; readonly job: RecognitionJob }
  | { readonly kind: "Cancel"; readonly operation: number }
  | { readonly kind: "ReleaseFragment"; readonly fragmentId: string }
  | { readonly kind: "Onset"; readonly turnId: string; readonly generation: number; readonly fenceId: string }
  | { readonly kind: "Interim"; readonly turnId: string; readonly generation: number; readonly text: string }
  | { readonly kind: "Error"; readonly turnId: string; readonly generation: number; readonly error: RecognitionError }
  | { readonly kind: "Discarded"; readonly turnId: string; readonly generation: number }
  | {
      readonly kind: "Trace"
      readonly cause: "recognitionStarted" | "recognitionSucceeded" | "recognitionDefect"
      readonly generation?: number
      readonly sampleFrames?: number
    }
