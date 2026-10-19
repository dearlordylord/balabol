import type { RecognitionInput, RecognitionCommand } from "./recognition-events.ts"
import type { OutputEvent, OutputCommand } from "./output-events.ts"
import type { VoiceDiagnosticInput } from "./diagnostics.ts"
import type { RecognitionFailureReason } from "../speech-recognition/index.ts"
import type { Message } from "../conversation/index.ts"
import type { SpeechPayload } from "./session-state.ts"
import type { VoiceEvent } from "./contracts.ts"
export type SessionEvent =
  | { readonly kind: "InitializeExpiry" }
  | { readonly kind: "ExpiryDue"; readonly operation: number; readonly deadlineAt: number; readonly now: number }
  | { readonly kind: "Activated" }
  | { readonly kind: "Joined" }
  | { readonly kind: "Renew"; readonly now: number }
  | { readonly kind: "Mute"; readonly muted: boolean; readonly now: number; readonly requestId: string }
  | { readonly kind: "End" }
  | { readonly kind: "Expire"; readonly now: number }
  | {
      readonly kind: "CaptureFailed"
      readonly generation: number
      readonly operation: number | null
      readonly code: string
      readonly message: string
    }
  | { readonly kind: "CaptureGap"; readonly generation: number }
  | { readonly kind: "Disconnected"; readonly code: string; readonly message?: string }
  | { readonly kind: "Released"; readonly resource: string }
  | {
      readonly kind: "Frame"
      readonly operation: number
      readonly generation: number
      readonly track: string
      readonly samples: number
    }
  | {
      readonly kind: "FenceApplied"
      readonly fenceId: string
      readonly generation: number
      readonly sequence: number
      readonly revision: bigint
    }
  | {
      readonly kind: "FenceRejected"
      readonly fenceId: string
      readonly generation: number
      readonly sequence: number
      readonly message: string
    }
  | { readonly kind: "Classified"; readonly operation: number }
  | { readonly kind: "Speech"; readonly generation: number; readonly fenceId: string }
  | { readonly kind: "Recognition"; readonly input: RecognitionInput }
  | { readonly kind: "Prepared"; readonly input: SpeechPayload }
  | {
      readonly kind: "AdmissionFailed"
      readonly id: string
      readonly code: string
      readonly message: string
      readonly handed: boolean
    }
  | { readonly kind: "Accepted"; readonly id: string; readonly receipt: Message }
  | { readonly kind: "AdmissionFinished"; readonly id: string }
  | { readonly kind: "Output"; readonly input: OutputEvent }
export type SessionCommand =
  | { readonly kind: "ScheduleExpiry"; readonly operation: number; readonly deadlineAt: number }
  | { readonly kind: "CancelExpiry"; readonly operation: number }
  | { readonly kind: "OutputWork"; readonly command: Exclude<OutputCommand, { kind: "Project" | "Trace" }> }
  | { readonly kind: "TraceOutput"; readonly input: VoiceDiagnosticInput }
  | {
      readonly kind: "RecognitionWork"
      readonly command: Extract<RecognitionCommand, { kind: "Recognize" | "Cancel" | "ReleaseFragment" }>
    }
  | {
      readonly kind: "TraceRecognition"
      readonly cause: "recognitionStarted" | "recognitionSucceeded" | "recognitionDefect"
      readonly generation?: number
      readonly sampleFrames?: number
    }
  | {
      readonly kind: "TraceEvent"
      readonly event: VoiceEvent
      readonly recognitionReason?: typeof RecognitionFailureReason.Type
    }
  | { readonly kind: "CancelAcquisition" }
  | { readonly kind: "ResetCapture" }
  | { readonly kind: "Release"; readonly resource: string }
  | { readonly kind: "Publish"; readonly event: VoiceEvent }
  | { readonly kind: "BeginAdmission"; readonly input: SpeechPayload; readonly sourceSequence: number }
  | { readonly kind: "SubmitAdmission"; readonly id: string; readonly event: VoiceEvent }
  | { readonly kind: "FenceSpeech"; readonly sequence: number; readonly fenceId: string; readonly generation: number }
