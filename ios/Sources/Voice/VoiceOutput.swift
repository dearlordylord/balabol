import Foundation

public struct VoiceOutputIdentity: Codable, Hashable, Sendable {
  public let inputDeliveryId: UUID
  public let responseId: UUID
  public let outputEpoch: UUID
}

public struct VoiceAudioManifest: Codable, Equatable, Sendable {
  public struct SourceAudio: Codable, Equatable, Sendable {
    public let encoding: String
    public let sampleRateHz: Int
    public let channels: Int
  }
  public let sessionId: UUID
  public let responseId: UUID
  public let inputDeliveryId: UUID
  public let outputEpoch: UUID
  public let publisherIdentity: UUID
  public let trackSid: String
  public let sourceAudio: SourceAudio
  public var identity: VoiceOutputIdentity {
    VoiceOutputIdentity(
      inputDeliveryId: inputDeliveryId, responseId: responseId, outputEpoch: outputEpoch)
  }
  public var isValid: Bool {
    !trackSid.isEmpty && trackSid.utf16.count <= 128 && sourceAudio.encoding == "pcm-s16le"
      && sourceAudio.sampleRateHz == 24_000 && sourceAudio.channels == 1
  }
}

public struct VoiceOutput: Codable, Equatable, Sendable {
  public enum Status: String, Codable, Sendable {
    case preparing = "Preparing"
    case awaitingReady = "AwaitingReady"
    case playing = "Playing"
    case delivered = "Delivered"
    case interrupted = "Interrupted"
    case failed = "Failed"
  }
  public struct Failure: Codable, Equatable, Sendable {
    public let code: String
    public let message: String
  }
  public let responseId: UUID
  public let inputDeliveryId: UUID
  public let outputEpoch: UUID
  public let status: Status
  public let manifest: VoiceAudioManifest?
  public let error: Failure?
  private enum CodingKeys: String, CodingKey {
    case responseId, inputDeliveryId, outputEpoch, status, manifest, error
  }
  public init(from decoder: any Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    responseId = try values.decode(UUID.self, forKey: .responseId)
    inputDeliveryId = try values.decode(UUID.self, forKey: .inputDeliveryId)
    outputEpoch = try values.decode(UUID.self, forKey: .outputEpoch)
    status = try values.decode(Status.self, forKey: .status)
    manifest = try values.decode(VoiceAudioManifest?.self, forKey: .manifest)
    error = try values.decode(Failure?.self, forKey: .error)
    guard isValid(sessionId: manifest?.sessionId ?? responseId) else {
      throw VoiceFailure.invalidResponse
    }
  }
  /// A canonical conversation failure retires the selected local playout even
  /// when the independently observed server output has not caught up yet.
  internal init(failing value: VoiceOutput) {
    responseId = value.responseId
    inputDeliveryId = value.inputDeliveryId
    outputEpoch = value.outputEpoch
    status = .failed
    manifest = value.manifest
    error = Failure(code: "AnswerFailed", message: "The answer could not be completed.")
  }
  public var identity: VoiceOutputIdentity {
    VoiceOutputIdentity(
      inputDeliveryId: inputDeliveryId, responseId: responseId, outputEpoch: outputEpoch)
  }
  public var isActive: Bool { [.preparing, .awaitingReady, .playing].contains(status) }
  public func isValid(sessionId: UUID) -> Bool {
    guard responseId != inputDeliveryId else { return false }
    if let manifest {
      guard manifest.isValid, manifest.sessionId == sessionId, manifest.identity == identity else {
        return false
      }
    }
    switch status {
    case .preparing: return manifest == nil && error == nil
    case .awaitingReady, .playing, .delivered: return manifest != nil && error == nil
    case .interrupted: return error == nil
    case .failed:
      return error.map {
        !$0.code.isEmpty && $0.code.utf16.count <= 100 && $0.message.utf16.count <= 1000
      } == true
    }
  }
}

/// Immutable output projection and acceptance policy, composed by VoiceState.
public struct VoiceOutputState: Equatable, Sendable {
  public let current: VoiceOutput?
  public let locallyInterrupted: Bool
  public let unavailable: Bool
  public let receivedAudio: Bool
  internal let closed: Bool
  internal let sequence: Int
  internal let lastAcceptedInput: UUID?
  internal let cutInput: UUID?
  internal let cutAcceptedInput: UUID?
  internal let cutPendingInputs: [UUID]
  internal let allowedInput: UUID?
  internal let gated: Bool
  internal let prepared: VoiceOutputIdentity?
  internal let interrupted: VoiceOutputIdentity?
  internal init(
    current: VoiceOutput? = nil,
    locallyInterrupted: Bool = false,
    unavailable: Bool = false,
    receivedAudio: Bool = false,
    closed: Bool = false,
    sequence: Int = -1,
    lastAcceptedInput: UUID? = nil,
    cutInput: UUID? = nil,
    cutAcceptedInput: UUID? = nil,
    cutPendingInputs: [UUID] = [],
    allowedInput: UUID? = nil,
    gated: Bool = false,
    prepared: VoiceOutputIdentity? = nil,
    interrupted: VoiceOutputIdentity? = nil
  ) {
    self.current = current
    self.locallyInterrupted = locallyInterrupted
    self.unavailable = unavailable
    self.receivedAudio = receivedAudio
    self.closed = closed
    self.sequence = sequence
    self.lastAcceptedInput = lastAcceptedInput
    self.cutInput = cutInput
    self.cutAcceptedInput = cutAcceptedInput
    self.cutPendingInputs = cutPendingInputs
    self.allowedInput = allowedInput
    self.gated = gated
    self.prepared = prepared
    self.interrupted = interrupted
  }
  internal func replacing(
    current: VoiceOutput?? = nil,
    locallyInterrupted: Bool? = nil,
    unavailable: Bool? = nil,
    receivedAudio: Bool? = nil,
    closed: Bool? = nil,
    sequence: Int? = nil,
    lastAcceptedInput: UUID?? = nil,
    cutInput: UUID?? = nil,
    cutAcceptedInput: UUID?? = nil,
    cutPendingInputs: [UUID]? = nil,
    allowedInput: UUID?? = nil,
    gated: Bool? = nil,
    prepared: VoiceOutputIdentity?? = nil,
    interrupted: VoiceOutputIdentity?? = nil
  ) -> VoiceOutputState {
    VoiceOutputState(
      current: current ?? self.current,
      locallyInterrupted: locallyInterrupted ?? self.locallyInterrupted,
      unavailable: unavailable ?? self.unavailable,
      receivedAudio: receivedAudio ?? self.receivedAudio,
      closed: closed ?? self.closed,
      sequence: sequence ?? self.sequence,
      lastAcceptedInput: lastAcceptedInput ?? self.lastAcceptedInput,
      cutInput: cutInput ?? self.cutInput,
      cutAcceptedInput: cutAcceptedInput ?? self.cutAcceptedInput,
      cutPendingInputs: cutPendingInputs ?? self.cutPendingInputs,
      allowedInput: allowedInput ?? self.allowedInput,
      gated: gated ?? self.gated,
      prepared: prepared ?? self.prepared,
      interrupted: interrupted ?? self.interrupted
    )
  }
}
