import Foundation

#if canImport(Conversation)
  import Conversation
#endif

public enum VoiceFailure: Error, Equatable, Sendable {
  case permissionDenied, capture, connection, invalidResponse
  case backend(code: String, message: String)
}

/// Credentials belong to the adapter bootstrap, never the presentation state.
public struct VoiceJoin: Codable, Sendable {
  public let sessionId: UUID
  public let roomName: String
  public let participantIdentity: String
  public let backendParticipantIdentity: UUID
  public let mediaUrl: String
  public let token: String
  internal let controlToken: String
  public let expiresAt: Double
}

public struct VoiceWireEvent: Decodable, Sendable {
  public let sequence: Int
  public let sessionId: UUID
  public let kind: String
  public let utteranceId: UUID?
  public let deliveryId: UUID?
  public let text: String?
  public let receipt: ConversationMessage?
  public let muted: Bool?
  public let reason: String?
  public let code: String?
  public let message: String?
  public let output: VoiceOutput?
  public var isValid: Bool {
    guard sequence > 0 else { return false }
    switch kind {
    case "Interim": return utteranceId != nil && validText
    case "Final": return utteranceId != nil && deliveryId == utteranceId && validText
    case "Accepted":
      return utteranceId != nil && receipt?.isValid == true && receipt?.role == .user
        && receipt?.deliveryId == utteranceId
    case "Discarded": return utteranceId != nil && reason == "Empty"
    case "Output": return output?.isValid(sessionId: sessionId) == true
    case "Muted": return muted != nil
    case "Ended": return true
    case "Error": return code?.isEmpty == false && message?.isEmpty == false
    default: return false
    }
  }
  private var validText: Bool { text?.isEmpty == false && (text?.utf16.count ?? 0) <= 100_000 }
}

public struct VoicePending: Decodable, Sendable {
  public struct Failure: Decodable, Sendable {
    public let code: String
    public let message: String
  }
  public let utteranceId: UUID
  public let deliveryId: UUID
  public let text: String
  public let receipt: ConversationMessage?
  public let error: Failure?
  public var isValid: Bool {
    guard utteranceId == deliveryId, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      text.utf16.count <= 100_000, receipt == nil || error == nil
    else { return false }
    if let receipt {
      return receipt.isValid && receipt.role == .user && receipt.deliveryId == deliveryId
        && receipt.text == text
    }
    if let error { return !error.code.isEmpty && !error.message.isEmpty }
    return true
  }
}

public struct VoiceSnapshot: Decodable, Sendable {
  public let sessionId: UUID
  public let status: String
  public let muted: Bool
  public let sequence: Int
  public let events: [VoiceWireEvent]
  public let nextAfter: Int?
  public let firstSequence: Int
  public let audioFramesReceived: Int
  public let sampleFramesReceived: Int
  public let pending: [VoicePending]
  public let output: VoiceOutput?
  internal init(
    sessionId: UUID, status: String, muted: Bool, sequence: Int,
    events: [VoiceWireEvent], nextAfter: Int?, firstSequence: Int? = nil,
    audioFramesReceived: Int = 0, sampleFramesReceived: Int = 0, pending: [VoicePending] = [],
    output: VoiceOutput? = nil
  ) {
    self.sessionId = sessionId
    self.status = status
    self.muted = muted
    self.sequence = sequence
    self.events = events
    self.nextAfter = nextAfter
    self.firstSequence = firstSequence ?? events.first?.sequence ?? sequence + 1
    self.audioFramesReceived = audioFramesReceived
    self.sampleFramesReceived = sampleFramesReceived
    self.pending = pending
    self.output = output
  }
}

public protocol VoiceControl: Sendable {
  func start() async throws -> VoiceJoin
  func snapshot(sessionId: UUID, after: Int) async throws -> VoiceSnapshot
  func mute(sessionId: UUID, muted: Bool) async throws
  func end(sessionId: UUID) async throws
  func ready(sessionId: UUID, manifest: VoiceAudioManifest) async throws -> VoiceSnapshot
  func interrupt(sessionId: UUID, target: VoiceOutputIdentity) async throws -> VoiceSnapshot
}

@MainActor public protocol VoiceMedia: AnyObject {
  func requestPermission() async -> Bool
  func connect(
    _ join: VoiceJoin, failure: @escaping @Sendable () -> Void,
    speechStarted: @escaping @Sendable () -> Void,
    outputReceived: @escaping @Sendable (VoiceOutputIdentity) -> Void) async throws
  func mute(_ muted: Bool) async throws
  func disconnect() async
  func prepareOutput(_ manifest: VoiceAudioManifest) async throws
  func stopOutput() -> Task<Void, Never>
}
