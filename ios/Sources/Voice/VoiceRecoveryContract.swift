import Foundation

#if canImport(Conversation)
  import Conversation
#endif

/// Provenance is metadata, never authority to append or to replay recognized text.
public struct VoiceAdmissionAssociation: Codable, Hashable, Sendable {
  public let backendIncarnationId: UUID
  public let sessionId: UUID
  public let deliveryId: UUID
  public let detectedLanguage: String?
  public var isValid: Bool { detectedLanguage.map(LanguageSpan.isValidLanguageTag) ?? true }
  public var identity: Self {
    Self(backendIncarnationId: backendIncarnationId, sessionId: sessionId, deliveryId: deliveryId)
  }
  public init(
    backendIncarnationId: UUID, sessionId: UUID, deliveryId: UUID, detectedLanguage: String? = nil
  ) {
    self.backendIncarnationId = backendIncarnationId
    self.sessionId = sessionId
    self.deliveryId = deliveryId
    self.detectedLanguage = detectedLanguage
  }
  private enum CodingKeys: String, CodingKey {
    case backendIncarnationId, sessionId, deliveryId, detectedLanguage
  }
  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    backendIncarnationId = try c.decode(UUID.self, forKey: .backendIncarnationId)
    sessionId = try c.decode(UUID.self, forKey: .sessionId)
    deliveryId = try c.decode(UUID.self, forKey: .deliveryId)
    detectedLanguage = try c.decodeIfPresent(String.self, forKey: .detectedLanguage)
    guard isValid else {
      throw VoiceFailure.invalidResponse
    }
  }
}

public struct VoiceAdmissionResolution: Decodable, Sendable {
  public struct Admission: Decodable, Sendable {
    public enum Status: String, Decodable, Sendable {
      case accepted = "Accepted"
      case notAccepted = "NotAccepted"
      case unknown = "Unknown"
    }
    public let backendIncarnationId: UUID
    public let sessionId: UUID
    public let deliveryId: UUID
    public let status: Status
    public let receipt: ConversationMessage?
    public var association: VoiceAdmissionAssociation {
      VoiceAdmissionAssociation(
        backendIncarnationId: backendIncarnationId, sessionId: sessionId, deliveryId: deliveryId)
    }
    public var isValid: Bool {
      switch status {
      case .accepted:
        return receipt?.isValid == true && receipt?.role == .user
          && receipt?.deliveryId == deliveryId
      case .notAccepted, .unknown: return receipt == nil
      }
    }
  }
  public let admissions: [Admission]
  public func isValid(for expected: [VoiceAdmissionAssociation]) -> Bool {
    !expected.isEmpty && expected.count <= 2 && admissions.count == expected.count
      && admissions.allSatisfy(\.isValid)
      && Set(admissions.map { $0.association.identity }) == Set(expected.map(\.identity))
      && Set(admissions.map(\.deliveryId)).count == admissions.count
  }
}

public protocol VoiceRetryClock: Sendable {
  func sleep(milliseconds: Int) async throws
}
public struct SystemVoiceRetryClock: VoiceRetryClock {
  public init() {}
  public func sleep(milliseconds: Int) async throws {
    try await Task.sleep(for: .milliseconds(milliseconds))
  }
}
