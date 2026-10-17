import type { Reply, ReplyDeliveryUpdate, ResponseTarget } from "../conversation/index.ts"
import type { OutputReady, OutputInterrupt, VoiceOutput } from "./contracts.ts"
import type { VoiceDiagnosticInput } from "./diagnostics.ts"
import type { OutputKey, OutputError, OutputState, OutputContext, OutputDecision } from "./output-state.ts"
import type { Phrase } from "./phrases.ts"
export type OutputOutcome =
  | { readonly kind: "Success" }
  | { readonly kind: "Failure"; readonly error: OutputError }
  | { readonly kind: "Interrupted" }
type Correlated = { readonly operation: number; readonly key: OutputKey }
export type OutputEvent =
  | { readonly kind: "Attach" }
  | {
      readonly kind: "Registered"
      readonly operation: number
      readonly registrationId: string
      readonly snapshot: ReplyDeliveryUpdate
      readonly outputEpoch: string
    }
  | { readonly kind: "RegistrationFailed"; readonly operation: number; readonly error: OutputError }
  | { readonly kind: "SubscriptionFailed"; readonly registrationId: string; readonly error: OutputError }
  | { readonly kind: "DeliveryUpdate"; readonly update: ReplyDeliveryUpdate; readonly outputEpoch: string }
  | {
      readonly kind: "Speech"
      readonly suppress: readonly string[]
      readonly generation?: number
      readonly fenceId: string
      readonly sequence: number
    }
  | {
      readonly kind: "FenceSettled"
      readonly fenceId: string
      readonly sequence: number
      readonly status: "Applied" | "Rejected"
    }
  | { readonly kind: "AdmissionReleased"; readonly inputDeliveryId: string }
  | { readonly kind: "Interrupt"; readonly input: OutputInterrupt }
  | { readonly kind: "Retire" }
  | ({
      readonly kind: "PublicationOpened"
      readonly publisherIdentity: string
      readonly trackSid: string
      readonly now: number
    } & Correlated)
  | ({ readonly kind: "PublicationFailed"; readonly error: OutputError } & Correlated)
  | { readonly kind: "Ready"; readonly input: OutputReady }
  | ({ readonly kind: "ReadyDeadline" } & Correlated)
  | ({ readonly kind: "ReplyObserved"; readonly reply: Reply; readonly phraseId: string } & Correlated)
  | ({
      readonly kind: "SynthesisPacket"
      readonly responseId: string
      readonly phraseId: string
      readonly sequence: number
      readonly packet:
        | { readonly kind: "Completed" }
        | { readonly kind: "Chunk"; readonly payloadId: string; readonly sampleFrames: number }
    } & Correlated)
  | ({ readonly kind: "CaptureFinished"; readonly outcome: OutputOutcome } & Correlated)
  | ({ readonly kind: "SynthesisSettled"; readonly outcome: OutputOutcome; readonly nextPhraseId: string } & Correlated)
  | ({ readonly kind: "Drained" } & Correlated)
  | ({ readonly kind: "WorkFailed"; readonly error: OutputError } & Correlated)
  | ({ readonly kind: "DeliverySettled" } & Correlated)
  | ({ readonly kind: "DeliveryRejected"; readonly error: OutputError } & Correlated)
  | { readonly kind: "InterruptApplied"; readonly operation: number; readonly target: ResponseTarget }
  | {
      readonly kind: "InterruptRejected"
      readonly operation: number
      readonly target: ResponseTarget
      readonly error: OutputError
    }
  | { readonly kind: "Unregistered"; readonly operation: number; readonly registrationId: string }
  | {
      readonly kind: "UnregisterRejected"
      readonly operation: number
      readonly registrationId: string
      readonly error: OutputError
    }
  | { readonly kind: "Released"; readonly operation: number }
export type OutputCommand =
  | { readonly kind: "Register"; readonly operation: number; readonly completionMillis: number }
  | {
      readonly kind: "Unregister"
      readonly operation: number
      readonly parentOperation: number
      readonly registrationId: string
      readonly delayMillis: number
    }
  | ({ readonly kind: "OpenPublication" } & Correlated)
  | { readonly kind: "RevokePublication"; readonly publicationOperation: number }
  | {
      readonly kind: "ClosePublication"
      readonly operation: number
      readonly parentOperation: number
      readonly delayMillis: number
    }
  | ({ readonly kind: "StartReadyTimer"; readonly deadlineAt: number } & Correlated)
  | ({ readonly kind: "ReadReply"; readonly delayMillis: number } & Correlated)
  | ({ readonly kind: "Synthesize"; readonly phraseId: string; readonly phrase: Phrase } & Correlated)
  | ({ readonly kind: "Capture"; readonly publicationOperation: number; readonly payloadId: string } & Correlated)
  | { readonly kind: "ReleasePayload"; readonly payloadId: string }
  | ({ readonly kind: "Drain"; readonly publicationOperation: number } & Correlated)
  | ({
      readonly kind: "SettleDelivery"
      readonly outcome: "Completed" | "Failed"
      readonly error: OutputError | null
    } & Correlated)
  | {
      readonly kind: "InterruptResponse"
      readonly operation: number
      readonly target: ResponseTarget
      readonly acknowledge?: true
    }
  | { readonly kind: "Cancel"; readonly operation: number }
  | { readonly kind: "Project"; readonly output: VoiceOutput }
  | {
      readonly kind: "Trace"
      readonly cause: VoiceDiagnosticInput["cause"]
      readonly errorCode?: VoiceDiagnosticInput["errorCode"]
      readonly failureReason?: VoiceDiagnosticInput["failureReason"]
      readonly applied: boolean
      readonly target?: ResponseTarget & { readonly outputEpoch?: string }
      readonly generation?: number
      readonly priorStatus?: VoiceDiagnosticInput["priorStatus"]
    }
export interface OutputTransition {
  readonly state: OutputState
  readonly commands: readonly OutputCommand[]
  readonly decision: OutputDecision
}
export type OutputHandler = (state: OutputState, event: OutputEvent, context: OutputContext) => OutputTransition
