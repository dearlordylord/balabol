import type { Effect, Redacted, Scope } from "effect"
import type { Conversation } from "../conversation/index.ts"
import type { SpeechRecognition } from "../speech-recognition/index.ts"
import type { SpeechSynthesis } from "../speech-synthesis/index.ts"
import type {
  VoiceTransport,
  VoiceFailed,
  VoiceJoin,
  VoiceSnapshot,
  OutputReady,
  OutputInterrupt
} from "./contracts.ts"
import type { VoiceAdmissions } from "./admissions.ts"
import type { SpeechActivity } from "./activity.ts"
import type { VoiceDiagnostics } from "./diagnostics.ts"
import type { VoiceLanguageCapabilities } from "./languages.ts"
import type { VoiceOutputSettings } from "./output-configuration.ts"
import type { StartVoiceRequest } from "./recovery-contracts.ts"
export interface SessionIdentity {
  readonly sessionId: string
  readonly roomName: string
  readonly participantIdentity: string
  readonly controlToken: Redacted.Redacted<string>
}
export interface SessionRetention {
  /** Strictly increasing within one session; allocated only by its state writer. */
  readonly revision: number
  readonly sessionId: string
  readonly status: "active" | "closing" | "ended"
  readonly pendingAdmissions: number
  readonly releaseComplete: boolean
}
export interface SessionDependencies {
  readonly conversation: Conversation["Service"]
  readonly provider: SpeechRecognition["Service"]
  readonly activity: SpeechActivity["Service"]
  readonly synthesis: SpeechSynthesis["Service"]
  readonly transport: VoiceTransport["Service"]
  readonly admissions: VoiceAdmissions["Service"]
  readonly languages: VoiceLanguageCapabilities
  readonly outputSettings: VoiceOutputSettings
  readonly diagnostics: VoiceDiagnostics["Service"]
  readonly hostScope: Scope.Scope
}
export interface SessionHandle {
  readonly authorize: (token: string) => Effect.Effect<void, VoiceFailed>
  readonly snapshot: (after: number) => Effect.Effect<VoiceSnapshot, VoiceFailed>
  readonly mute: (muted: boolean) => Effect.Effect<VoiceSnapshot, VoiceFailed>
  readonly ready: (input: OutputReady) => Effect.Effect<VoiceSnapshot, VoiceFailed>
  readonly interrupt: (input: OutputInterrupt) => Effect.Effect<VoiceSnapshot, VoiceFailed>
  readonly end: () => Effect.Effect<VoiceSnapshot, VoiceFailed>
  /** Commits expiry immediately; physical cleanup never blocks the registry writer. */
  readonly expire: (now: number) => Effect.Effect<void>
  /** Called on eviction or host shutdown; handed admissions keep their host lifetime. */
  readonly dispose: () => Effect.Effect<void>
}
/** Failure acknowledges settled acquisition/release obligations; no capture precedes successful acquisition. */
export type SessionFactory = (
  identity: SessionIdentity,
  request: StartVoiceRequest,
  startedAt: number,
  retention: (fact: SessionRetention) => Effect.Effect<void>
) => Effect.Effect<{ readonly handle: SessionHandle; readonly join: VoiceJoin }, VoiceFailed>
