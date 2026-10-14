import Foundation

#if canImport(Conversation)
  import Conversation
#endif

/// Provenance is metadata, never authority to append or to replay recognized text.
public struct VoiceAdmissionAssociation: Codable, Hashable, Sendable {
  public let backendIncarnationId: UUID
  public let sessionId: UUID
  public let deliveryId: UUID
  public init(backendIncarnationId: UUID, sessionId: UUID, deliveryId: UUID) {
    self.backendIncarnationId = backendIncarnationId
    self.sessionId = sessionId
    self.deliveryId = deliveryId
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
      && Set(admissions.map(\.association)) == Set(expected)
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
