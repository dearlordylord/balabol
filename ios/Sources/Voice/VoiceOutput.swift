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

/// Output metadata is separate from capture and durable input admission.
public struct VoiceOutputState: Equatable, Sendable {
  public internal(set) var current: VoiceOutput?
  public internal(set) var locallyInterrupted = false
  public internal(set) var unavailable = false
  public internal(set) var receivedAudio = false
  internal var closed = false
  internal var sequence = -1
  internal var lastAcceptedInput: UUID?
  internal var cutInput: UUID?
  internal var cutAcceptedInput: UUID?
  internal var cutPendingInputs: [UUID] = []
  internal var allowedInput: UUID?
  internal var gated = false
  internal var prepared: VoiceOutputIdentity?
  internal var interrupted: VoiceOutputIdentity?
}
