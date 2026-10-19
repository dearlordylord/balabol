import Foundation

#if canImport(Conversation)
  import Conversation
#endif

/// One immutable feature value owns capture, recovery and output decisions.
/// Start changes in VoiceFeatureTransition; the ViewModel only interprets commands.
public struct VoiceState: Equatable, Sendable {
  /// One recoverable input notice; it never owns playout or admission state.
  public enum InputNotice: Equatable, Sendable {
    case unrecognized(UUID)
    case captureDiscontinuity(UUID)
    internal var utteranceId: UUID? {
      switch self {
      case .unrecognized(let id): id
      case .captureDiscontinuity(let id): id
      }
    }
    public var message: String {
      switch self {
      case .unrecognized: "Couldn’t recognize that. Please repeat."
      case .captureDiscontinuity: "I missed part of that. Please repeat."
      }
    }
  }
  public enum Capture: Equatable, Sendable {
    case idle, requestingMicrophone, connecting, reconnecting, hostUnavailable,
      checkingPreviousSpeech, listening, muted, paused, resuming, ending, ended
    case failed(VoiceFailure)
  }
  public enum Admission: Equatable, Sendable {
    case saving(deliveryId: UUID, text: String)
    case checking(deliveryId: UUID, text: String)
    case saved(ConversationMessage)
    case failed(text: String, VoiceFailure)
  }
  public enum Intent: Equatable, Sendable {
    case off
    case listening(muted: Bool)
  }
  internal let captureModel: VoiceCaptureState
  internal let recovery: VoiceAdmissionState
  internal let languageModel: VoiceLanguageState
  public let output: VoiceOutputState
  internal let execution: VoiceExecutionState
  public init() {
    self.init(capture: VoiceCaptureState(), recovery: VoiceAdmissionState(),
      languages: VoiceLanguageState(), output: VoiceOutputState(), execution: VoiceExecutionState())
  }
  internal init(capture: VoiceCaptureState, recovery: VoiceAdmissionState,
    languages: VoiceLanguageState, output: VoiceOutputState, execution: VoiceExecutionState) {
    captureModel = capture
    self.recovery = recovery
    languageModel = languages
    self.output = output
    self.execution = execution
  }
  internal func replacing(capture: VoiceCaptureState? = nil, recovery: VoiceAdmissionState? = nil,
    languages: VoiceLanguageState? = nil, output: VoiceOutputState? = nil, execution: VoiceExecutionState? = nil) -> VoiceState {
    VoiceState(capture: capture ?? captureModel, recovery: recovery ?? self.recovery,
      languages: languages ?? languageModel, output: output ?? self.output, execution: execution ?? self.execution)
  }
  public var intent: VoiceState.Intent { captureModel.intent }
  public var capture: VoiceState.Capture { captureModel.capture }
  internal var startRequestId: UUID? { captureModel.startRequestId }
  internal var startMuted: Bool { captureModel.startMuted }
  internal var bootstrapKnown: Bool { captureModel.bootstrapKnown }
  internal var retryStep: Int { captureModel.retryStep }
  internal var origin: VoiceOrigin? { captureModel.origin }
  internal var snapshotSequence: Int { captureModel.snapshotSequence }
  internal var generation: Int { captureModel.generation }
  internal var sequence: Int { captureModel.sequence }
  internal var muteInFlight: Bool { captureModel.muteInFlight }
  internal var resumeProbe: Bool { captureModel.resumeProbe }
  internal var drainingOrigin: VoiceOrigin? { captureModel.drainingOrigin }
  internal var isRetired: Bool { captureModel.isRetired }
  public var tentative: String { captureModel.tentative }
  internal var tentativeUtterance: UUID? { captureModel.tentativeUtterance }
  public var inputNotice: InputNotice? { captureModel.inputNotice }
  public var unrecognizedUtterance: UUID? {
    if case .unrecognized(let utterance) = inputNotice { return utterance }
    return nil
  }
  internal var recentAcceptedAdmissions: [VoiceAcceptedAdmission] { recovery.recentAcceptedAdmissions }
  internal var associations: [UUID: VoiceAdmissionAssociation] { recovery.associations }
  internal var stagedFinals: [UUID: String] { recovery.stagedFinals }
  internal var checkpointRevision: Int { recovery.checkpointRevision }
  internal var checkpointLoaded: Bool { recovery.checkpointLoaded }
  public var admissionFailure: VoiceFailure? { recovery.admissionFailure }
  public var admissionLanguageSpans: [UUID: [LanguageSpan]] { recovery.admissionLanguageSpans }
  public var admissions: [UUID: VoiceState.Admission] { recovery.admissions }
  public var utterances: [UUID] { recovery.utterances }
  public var languages: VoiceLanguages? { languageModel.languages }
  public var languageFailure: VoiceFailure? { languageModel.failure }
  internal var sessionId: UUID? { captureModel.origin?.sessionId }
  internal var backendIncarnationId: UUID? { captureModel.origin?.backendIncarnationId }
  internal var drainingSession: UUID? { captureModel.drainingOrigin?.sessionId }
  internal var drainingIncarnation: UUID? { captureModel.drainingOrigin?.backendIncarnationId }
  public var wantsListening: Bool { if case .listening = intent { true } else { false } }
  public var wantsMuted: Bool { if case .listening(let muted) = intent { muted } else { false } }
  public var canSwitchServer: Bool { checkpointLoaded && !isRetired && !wantsListening && !hasPendingAdmission && associations.isEmpty }
  public var admission: Admission? { utterances.last.flatMap { admissions[$0] } }
  public var canResume: Bool { capture == .paused && wantsListening }
  public var isChangingMute: Bool { muteInFlight }
  public var canStart: Bool {
    switch capture { case .idle, .ended, .failed: !wantsListening; default: false }
  }
  public var hasPendingAdmission: Bool {
    !associations.isEmpty || admissions.values.contains { value in
      switch value { case .saving, .checking: true; default: false }
    }
  }
  internal var isConnecting: Bool { capture == .connecting || capture == .resuming }
}

/// Platform availability never authorizes reopening capture without Resume.
public enum VoicePlatformEvent: Equatable, Sendable {
  case interrupted
  case resumeRecommended(Bool)
  case routeChanged(privateOutputRemoved: Bool)
  case servicesLost, servicesReset
}
