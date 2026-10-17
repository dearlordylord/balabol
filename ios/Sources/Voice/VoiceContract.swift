import Foundation

#if canImport(Conversation)
  import Conversation
#endif

public enum VoiceFailure: Error, Equatable, Sendable {
  case permissionDenied, capture, connection, invalidResponse, checkpointUnavailable
  /// An unclassified adapter defect, without private error text or an inferred retry policy.
  case unexpectedOperation
  case backend(code: String, message: String)
}

/// Credentials belong to the adapter bootstrap, never the presentation state.
public struct VoiceJoin: Codable, Sendable {
  public let sessionId: UUID
  public let startRequestId: UUID
  public let backendIncarnationId: UUID
  public let joinDeadlineAt: Double
  public let controlDeadlineAt: Double
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
  public let backendIncarnationId: UUID?
  public let utteranceId: UUID?
  public let deliveryId: UUID?
  public let text: String?
  public let detectedLanguage: String?
  public let languageSpans: [LanguageSpan]?
  public let receipt: ConversationMessage?
  public let muted: Bool?
  public let reason: String?
  public let code: String?
  public let message: String?
  public let output: VoiceOutput?
  private enum CodingKeys: String, CodingKey {
    case sequence, sessionId, kind, backendIncarnationId, utteranceId, deliveryId, text,
      languageSpans, detectedLanguage,
      receipt, muted, reason, code, message, output
  }
  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    sequence = try c.decode(Int.self, forKey: .sequence)
    sessionId = try c.decode(UUID.self, forKey: .sessionId)
    kind = try c.decode(String.self, forKey: .kind)
    backendIncarnationId = try c.decodeIfPresent(UUID.self, forKey: .backendIncarnationId)
    utteranceId = try c.decodeIfPresent(UUID.self, forKey: .utteranceId)
    deliveryId = try c.decodeIfPresent(UUID.self, forKey: .deliveryId)
    text = try c.decodeIfPresent(String.self, forKey: .text)
    detectedLanguage = try c.decodeIfPresent(String.self, forKey: .detectedLanguage)
    languageSpans =
      c.contains(.languageSpans)
      ? try c.decode([LanguageSpan].self, forKey: .languageSpans) : nil
    receipt = try c.decodeIfPresent(ConversationMessage.self, forKey: .receipt)
    muted = try c.decodeIfPresent(Bool.self, forKey: .muted)
    reason = try c.decodeIfPresent(String.self, forKey: .reason)
    code = try c.decodeIfPresent(String.self, forKey: .code)
    message = try c.decodeIfPresent(String.self, forKey: .message)
    output = try c.decodeIfPresent(VoiceOutput.self, forKey: .output)
  }
  public var isValid: Bool {
    guard sequence > 0 else { return false }
    switch kind {
    case "Interim": return utteranceId != nil && validText
    case "Final":
      return backendIncarnationId != nil && utteranceId != nil && deliveryId == utteranceId
        && validText
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
  private var validText: Bool {
    text?.isEmpty == false && (text?.utf16.count ?? 0) <= 100_000
      && LanguageSpan.areValid(languageSpans ?? [], for: text ?? "")
      && (detectedLanguage.map(LanguageSpan.isValidLanguageTag) ?? true)
  }
}

public struct VoicePending: Decodable, Sendable {
  public struct Failure: Decodable, Sendable {
    public let code: String
    public let message: String
  }
  public let utteranceId: UUID
  public let backendIncarnationId: UUID
  public let deliveryId: UUID
  public let text: String
  public let languageSpans: [LanguageSpan]
  public let detectedLanguage: String?
  public let receipt: ConversationMessage?
  public let error: Failure?
  internal init(
    utteranceId: UUID, backendIncarnationId: UUID, deliveryId: UUID, text: String,
    receipt: ConversationMessage?, error: Failure?, languageSpans: [LanguageSpan] = [],
    detectedLanguage: String? = nil
  ) {
    self.utteranceId = utteranceId
    self.backendIncarnationId = backendIncarnationId
    self.deliveryId = deliveryId
    self.text = text
    self.receipt = receipt
    self.error = error
    self.languageSpans = languageSpans
    self.detectedLanguage = detectedLanguage
  }
  private enum CodingKeys: String, CodingKey {
    case utteranceId, backendIncarnationId, deliveryId, text, receipt, error, languageSpans,
      detectedLanguage
  }
  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    utteranceId = try c.decode(UUID.self, forKey: .utteranceId)
    backendIncarnationId = try c.decode(UUID.self, forKey: .backendIncarnationId)
    deliveryId = try c.decode(UUID.self, forKey: .deliveryId)
    text = try c.decode(String.self, forKey: .text)
    receipt = try c.decodeIfPresent(ConversationMessage.self, forKey: .receipt)
    error = try c.decodeIfPresent(Failure.self, forKey: .error)
    detectedLanguage = try c.decodeIfPresent(String.self, forKey: .detectedLanguage)
    languageSpans =
      c.contains(.languageSpans)
      ? try c.decode([LanguageSpan].self, forKey: .languageSpans) : []
  }
  public var isValid: Bool {
    guard utteranceId == deliveryId, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      text.utf16.count <= 100_000, LanguageSpan.areValid(languageSpans, for: text),
      detectedLanguage.map(LanguageSpan.isValidLanguageTag) ?? true,
      receipt == nil || error == nil
    else { return false }
    if let receipt {
      return receipt.isValid && receipt.role == .user && receipt.deliveryId == deliveryId
        && receipt.text == text && receipt.languageSpans == languageSpans
        && receipt.detectedLanguage == detectedLanguage
    }
    if let error { return !error.code.isEmpty && !error.message.isEmpty }
    return true
  }
}

public struct VoiceSnapshot: Decodable, Sendable {
  public let sessionId: UUID
  public let backendIncarnationId: UUID
  public let controlDeadlineAt: Double
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
    backendIncarnationId: UUID = UUID(), controlDeadlineAt: Double = 9_999_999_999_999,
    events: [VoiceWireEvent], nextAfter: Int?, firstSequence: Int? = nil,
    audioFramesReceived: Int = 0, sampleFramesReceived: Int = 0, pending: [VoicePending] = [],
    output: VoiceOutput? = nil
  ) {
    self.sessionId = sessionId
    self.backendIncarnationId = backendIncarnationId
    self.controlDeadlineAt = controlDeadlineAt
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

/// Producer closure is not an admission verdict. Known speech associations
/// remain independently checking even when their media producer is absent.
public enum VoiceSealResult: Sendable {
  case ended(VoiceSnapshot)
  case producerUnavailable(sessionId: UUID, backendIncarnationId: UUID)
}

public protocol VoiceControl: Sendable {
  func languages() async throws -> VoiceLanguages
  func start(requestId: UUID, muted: Bool) async throws -> VoiceJoin
  func resolve(admissions: [VoiceAdmissionAssociation]) async throws -> VoiceAdmissionResolution
  func retain(admissions: [VoiceAdmissionAssociation]) async
  func snapshot(sessionId: UUID, after: Int) async throws -> VoiceSnapshot
  func mute(sessionId: UUID, muted: Bool) async throws
  func seal(sessionId: UUID) async throws -> VoiceSealResult
  func end(sessionId: UUID) async throws
  func ready(sessionId: UUID, manifest: VoiceAudioManifest) async throws -> VoiceSnapshot
  func interrupt(sessionId: UUID, target: VoiceOutputIdentity) async throws -> VoiceSnapshot
}

@MainActor public protocol VoiceMedia: AnyObject {
  func observePlatform(_ receive: @escaping @MainActor @Sendable (VoicePlatformEvent) -> Void)
  func retirePlatformObservation()
  func fenceCapture() -> Task<Void, Never>
  func requestPermission() async -> Bool
  func connect(
    _ join: VoiceJoin, initiallyMuted: Bool, failure: @escaping @Sendable () -> Void,
    speechStarted: @escaping @MainActor @Sendable () -> Void,
    outputReceived: @escaping @Sendable (VoiceOutputIdentity) -> Void) async throws
  func mute(_ muted: Bool) async throws
  func disconnect() async
  func prepareOutput(_ manifest: VoiceAudioManifest) async throws
  func stopOutput() -> Task<Void, Never>
}

extension VoiceControl {
  public func languages() async throws -> VoiceLanguages { throw VoiceFailure.connection }
  public func start() async throws -> VoiceJoin { try await start(requestId: UUID(), muted: false) }
  public func retain(admissions: [VoiceAdmissionAssociation]) async {}
}

extension VoiceMedia {
  public func observePlatform(
    _ receive: @escaping @MainActor @Sendable (VoicePlatformEvent) -> Void
  ) {}
  public func retirePlatformObservation() {}
  public func fenceCapture() -> Task<Void, Never> { Task {} }
}
