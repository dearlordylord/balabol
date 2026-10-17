import Foundation

internal enum VoiceOperationKind: Equatable, Sendable {
  case permission, languages, restoreCheckpoint
  case checkpoint(Int, [VoiceAdmissionAssociation])
  case bootstrap(UUID, Bool)
  case connect(VoiceOrigin, Bool)
  case localMute(Bool)
  case remoteMute(VoiceOrigin, Bool)
  case snapshot(VoiceOrigin, Int)
  case resolve([VoiceAdmissionAssociation])
  case seal(VoiceOrigin)
  case endBootstrap(VoiceOrigin)
  case stopMedia(Bool, Bool, VoiceOutputIdentity?, UUID?)
  case disconnect
  case prepareOutput(VoiceAudioManifest)
  case ready(VoiceOrigin, VoiceAudioManifest)
  case interrupt(VoiceOrigin, VoiceOutputIdentity)
  case sleep(Int, VoiceTimerPurpose)
  case observePlatform, retirePlatformObservation
  init(_ work: VoiceWork) {
    switch work {
    case .permission: self = .permission
    case .languages: self = .languages
    case .restoreCheckpoint: self = .restoreCheckpoint
    case .checkpoint(let revision, let values): self = .checkpoint(revision, values)
    case .bootstrap(let id, let muted): self = .bootstrap(id, muted)
    case .connect(let join, let muted): self = .connect(VoiceOrigin(sessionId: join.sessionId,
      backendIncarnationId: join.backendIncarnationId), muted)
    case .localMute(let muted): self = .localMute(muted)
    case .remoteMute(let origin, let muted): self = .remoteMute(origin, muted)
    case .snapshot(let origin, let after): self = .snapshot(origin, after)
    case .resolve(let values): self = .resolve(values)
    case .seal(let origin): self = .seal(origin)
    case .endBootstrap(let id): self = .endBootstrap(id)
    case .stopMedia(let capture, let output, let target, let session): self = .stopMedia(capture, output, target, session)
    case .disconnect: self = .disconnect
    case .prepareOutput(let manifest): self = .prepareOutput(manifest)
    case .ready(let origin, let manifest): self = .ready(origin, manifest)
    case .interrupt(let origin, let target): self = .interrupt(origin, target)
    case .sleep(let milliseconds, let purpose): self = .sleep(milliseconds, purpose)
    case .observePlatform: self = .observePlatform
    case .retirePlatformObservation: self = .retirePlatformObservation
    }
  }
}
internal struct VoiceOperation: Equatable, Sendable {
  let kind: VoiceOperationKind
  let cancelling: Bool
}
internal struct VoiceExecutionState: Equatable, Sendable {
  let bootstrapReleases: [VoiceOrigin: VoiceBootstrapRelease]
  let operations: [VoiceRequest: VoiceOperation]
  let nextRequest: Int
  let activeCapture: VoiceRequest?
  let platformObservation: VoiceRequest?
  let preparedOutput: VoiceOutputIdentity?
  let localStop: VoiceRequest?
  let shuttingDown: Bool
  let resolutionStep: Int
  init(bootstrapReleases: [VoiceOrigin: VoiceBootstrapRelease] = [:], operations: [VoiceRequest: VoiceOperation] = [:], nextRequest: Int = 1,
    activeCapture: VoiceRequest? = nil, platformObservation: VoiceRequest? = nil,
    preparedOutput: VoiceOutputIdentity? = nil, localStop: VoiceRequest? = nil, shuttingDown: Bool = false, resolutionStep: Int = 0) {
    self.bootstrapReleases = bootstrapReleases
    self.operations = operations
    self.nextRequest = nextRequest
    self.activeCapture = activeCapture
    self.platformObservation = platformObservation
    self.preparedOutput = preparedOutput
    self.localStop = localStop
    self.shuttingDown = shuttingDown
    self.resolutionStep = resolutionStep
  }
  func replacing(bootstrapReleases: [VoiceOrigin: VoiceBootstrapRelease]? = nil, operations: [VoiceRequest: VoiceOperation]? = nil, nextRequest: Int? = nil,
    activeCapture: VoiceRequest?? = nil, platformObservation: VoiceRequest?? = nil,
    preparedOutput: VoiceOutputIdentity?? = nil, localStop: VoiceRequest?? = nil, shuttingDown: Bool? = nil, resolutionStep: Int? = nil) -> VoiceExecutionState {
    VoiceExecutionState(bootstrapReleases: bootstrapReleases ?? self.bootstrapReleases, operations: operations ?? self.operations, nextRequest: nextRequest ?? self.nextRequest,
      activeCapture: activeCapture ?? self.activeCapture, platformObservation: platformObservation ?? self.platformObservation,
      preparedOutput: preparedOutput ?? self.preparedOutput, localStop: localStop ?? self.localStop, shuttingDown: shuttingDown ?? self.shuttingDown,
      resolutionStep: resolutionStep ?? self.resolutionStep)
  }
}
internal struct VoiceBootstrapRelease: Equatable, Sendable {
  let origin: VoiceOrigin
  let lastFailure: VoiceFailure?
}
