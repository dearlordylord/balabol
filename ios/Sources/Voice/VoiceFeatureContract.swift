import Foundation

#if canImport(Conversation)
  import Conversation
#endif

/// Feature decisions reserve these identities before the interpreter starts work.
internal struct VoiceRequest: Hashable, Sendable {
  let generation: Int
  let id: Int
}

internal struct VoiceOrigin: Hashable, Sendable {
  let sessionId: UUID
  let backendIncarnationId: UUID
}
internal enum VoiceTimerPurpose: Equatable, Sendable {
  case captureRetry
  case observation(VoiceOrigin)
  case resolution
  case bootstrapCleanup(VoiceOrigin)
}

/// The generated proposal is supplied at the boundary, including recovery facts.
/// An unused proposal has no domain meaning and is never a retry identity.
internal struct VoiceInput: Sendable {
  let event: VoiceFeatureEvent
  let proposedStartRequestId: UUID
}

internal enum VoiceFeatureEvent: Sendable {
  case restore, loadLanguages, start, resume, mute, end, shutdown
  case speechIntent
  case inputIntent(UUID)
  case generationCue(input: UUID, response: UUID, cue: VoiceProgressCue)
  case cancelGenerationCue
  case completed(VoiceRequest, VoiceWorkResult)
  case platform(VoiceRequest, VoicePlatformEvent)
  case captureFailed(VoiceRequest)
  case speech(VoiceRequest)
  case audioReceived(VoiceRequest, VoiceOutputIdentity)
}

/// One attempt per command. Retry, continuation and stale-result policy belong
/// to the feature transition; tasks never consult current feature state.
internal enum VoiceWork: Sendable {
  case permission
  case languages
  case restoreCheckpoint
  case checkpoint(revision: Int, associations: [VoiceAdmissionAssociation])
  case bootstrap(requestId: UUID, muted: Bool)
  case connect(VoiceJoin, muted: Bool)
  case localMute(Bool)
  case remoteMute(VoiceOrigin, Bool)
  case snapshot(VoiceOrigin, after: Int)
  case resolve([VoiceAdmissionAssociation])
  case seal(VoiceOrigin)
  case endBootstrap(VoiceOrigin)
  case stopMedia(capture: Bool, output: Bool, target: VoiceOutputIdentity?, session: UUID?, preservingFailureCue: Bool = false)
  case disconnect
  case prepareOutput(VoiceAudioManifest)
  case ready(VoiceOrigin, VoiceAudioManifest)
  case interrupt(VoiceOrigin, VoiceOutputIdentity)
  case sleep(milliseconds: Int, purpose: VoiceTimerPurpose)
  case observePlatform
  case retirePlatformObservation
}

internal enum VoiceWorkResult: Sendable {
  case permission(Bool)
  case languages(Result<VoiceLanguages, VoiceFailure>)
  case restored(Result<[VoiceAdmissionAssociation], VoiceFailure>)
  case checkpoint(Result<Void, VoiceFailure>)
  case bootstrapped(Result<VoiceJoin, VoiceFailure>)
  case connected(Result<Void, VoiceFailure>)
  case localMuted(Result<Void, VoiceFailure>)
  case remoteMuted(Result<Void, VoiceFailure>)
  case snapshot(Result<VoiceSnapshot, VoiceFailure>)
  case resolved(Result<VoiceAdmissionResolution, VoiceFailure>)
  case sealed(Result<VoiceSealResult, VoiceFailure>)
  case outputPrepared(Result<Void, VoiceFailure>)
  case ready(Result<VoiceSnapshot, VoiceFailure>)
  case interrupted(Result<VoiceSnapshot, VoiceFailure>)
  case bootstrapEnded(Result<Void, VoiceFailure>)
  case stopped, disconnected, platformObserved, platformRetired
  /// A correlated timer completion is an explicit time fact, not a clock read.
  case elapsed
  case timerFailed(VoiceFailure)
  /// Physical cancellation acknowledgement; it never manufactures acceptance.
  case cancelled
}

internal enum VoiceEffectCommand: Sendable {
  case run(VoiceRequest, VoiceWork, after: [VoiceRequest])
  case cancel([VoiceRequest])
  case accepted(ConversationMessage)
  case refreshConversation
  case generationCue(VoiceProgressCue)
  case cancelGenerationCue
  case interruptConversation([UUID], after: VoiceRequest)
  #if DEBUG
    case trace(
      VoiceTraceCause, target: VoiceOutputIdentity?, status: String?,
      failure: VoiceFailure?, session: UUID?)
  #endif
}

internal struct VoiceTransition: Sendable {
  let state: VoiceState
  let commands: [VoiceEffectCommand]
}

internal enum VoiceTraceCause: String, Codable, Sendable {
  case enabled, speech, input, platform, lifecycle, captureFailure, cut, end, shutdown
  // Cleanup task completion is not proof of SDK success or physical silence.
  case output, localStop, cleanupAttemptFinished, mediaCleanupFailed
  case interruptDispatch, interruptReturned, interruptFailed
  case failure, observationFailed, wireError, transportFailed
  case nativeCapture
  case onset, onsetAccepted, onsetRejected, audioReceived, playoutPrepared
}
