import Foundation

#if canImport(Conversation)
  import Conversation
#endif

internal struct VoiceCaptureState: Equatable, Sendable {
  let intent: VoiceState.Intent
  let capture: VoiceState.Capture
  let startRequestId: UUID?
  let startMuted: Bool
  let bootstrapKnown: Bool
  let retryStep: Int
  let origin: VoiceOrigin?
  let snapshotSequence: Int
  let generation: Int
  let sequence: Int
  let muteInFlight: Bool
  let resumeProbe: Bool
  let drainingOrigin: VoiceOrigin?
  let isRetired: Bool
  let tentative: String
  let tentativeUtterance: UUID?
  let unrecognizedUtterance: UUID?
  init(
    intent: VoiceState.Intent = .off,
    capture: VoiceState.Capture = .idle,
    startRequestId: UUID? = nil,
    startMuted: Bool = false,
    bootstrapKnown: Bool = false,
    retryStep: Int = 0,
    origin: VoiceOrigin? = nil,
    snapshotSequence: Int = -1,
    generation: Int = 0,
    sequence: Int = 0,
    muteInFlight: Bool = false,
    resumeProbe: Bool = false,
    drainingOrigin: VoiceOrigin? = nil,
    isRetired: Bool = false,
    tentative: String = "",
    tentativeUtterance: UUID? = nil,
    unrecognizedUtterance: UUID? = nil
  ) {
    self.intent = intent
    self.capture = capture
    self.startRequestId = startRequestId
    self.startMuted = startMuted
    self.bootstrapKnown = bootstrapKnown
    self.retryStep = retryStep
    self.origin = origin
    self.snapshotSequence = snapshotSequence
    self.generation = generation
    self.sequence = sequence
    self.muteInFlight = muteInFlight
    self.resumeProbe = resumeProbe
    self.drainingOrigin = drainingOrigin
    self.isRetired = isRetired
    self.tentative = tentative
    self.tentativeUtterance = tentativeUtterance
    self.unrecognizedUtterance = unrecognizedUtterance
  }
  func replacing(
    intent: VoiceState.Intent? = nil,
    capture: VoiceState.Capture? = nil,
    startRequestId: UUID?? = nil,
    startMuted: Bool? = nil,
    bootstrapKnown: Bool? = nil,
    retryStep: Int? = nil,
    origin: VoiceOrigin?? = nil,
    snapshotSequence: Int? = nil,
    generation: Int? = nil,
    sequence: Int? = nil,
    muteInFlight: Bool? = nil,
    resumeProbe: Bool? = nil,
    drainingOrigin: VoiceOrigin?? = nil,
    isRetired: Bool? = nil,
    tentative: String? = nil,
    tentativeUtterance: UUID?? = nil,
    unrecognizedUtterance: UUID?? = nil
  ) -> VoiceCaptureState {
    VoiceCaptureState(
      intent: intent ?? self.intent,
      capture: capture ?? self.capture,
      startRequestId: startRequestId ?? self.startRequestId,
      startMuted: startMuted ?? self.startMuted,
      bootstrapKnown: bootstrapKnown ?? self.bootstrapKnown,
      retryStep: retryStep ?? self.retryStep,
      origin: origin ?? self.origin,
      snapshotSequence: snapshotSequence ?? self.snapshotSequence,
      generation: generation ?? self.generation,
      sequence: sequence ?? self.sequence,
      muteInFlight: muteInFlight ?? self.muteInFlight,
      resumeProbe: resumeProbe ?? self.resumeProbe,
      drainingOrigin: drainingOrigin ?? self.drainingOrigin,
      isRetired: isRetired ?? self.isRetired,
      tentative: tentative ?? self.tentative,
      tentativeUtterance: tentativeUtterance ?? self.tentativeUtterance,
      unrecognizedUtterance: unrecognizedUtterance ?? self.unrecognizedUtterance
    )
  }
}
