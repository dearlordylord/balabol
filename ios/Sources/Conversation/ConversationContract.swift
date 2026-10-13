import Foundation

public struct PendingDelivery: Codable, Equatable, Sendable {
  public let deliveryId: UUID
  public let text: String
  public init(deliveryId: UUID, text: String) {
    self.deliveryId = deliveryId
    self.text = text
  }
}

public struct ConversationMessage: Codable, Equatable, Sendable, Identifiable {
  public enum Role: String, Codable, Sendable { case user, assistant }
  public let role: Role
  public let responseId: UUID?
  public let inputDeliveryId: UUID?
  public let deliveryId: UUID
  public let recordId: Int
  public let position: Int
  public let text: String
  public var id: UUID { deliveryId }
  public var isValid: Bool {
    guard recordId >= 0 && position >= 0 && !text.isEmpty && text.utf16.count <= 100_000 else {
      return false
    }
    switch role {
    case .user: return responseId == nil && inputDeliveryId == nil
    case .assistant:
      return responseId == deliveryId && inputDeliveryId != nil && inputDeliveryId != deliveryId
    }
  }
  public init(
    deliveryId: UUID, recordId: Int, position: Int, text: String, role: Role = .user,
    responseId: UUID? = nil, inputDeliveryId: UUID? = nil
  ) {
    self.role = role
    self.responseId = responseId
    self.inputDeliveryId = inputDeliveryId
    self.deliveryId = deliveryId
    self.recordId = recordId
    self.position = position
    self.text = text
  }
  private enum CodingKeys: String, CodingKey {
    case deliveryId, recordId, position, text, role, responseId, inputDeliveryId
  }
  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    role = try container.decodeIfPresent(Role.self, forKey: .role) ?? .user
    responseId = try container.decodeIfPresent(UUID.self, forKey: .responseId)
    inputDeliveryId = try container.decodeIfPresent(UUID.self, forKey: .inputDeliveryId)
    deliveryId = try container.decode(UUID.self, forKey: .deliveryId)
    recordId = try container.decode(Int.self, forKey: .recordId)
    position = try container.decode(Int.self, forKey: .position)
    text = try container.decode(String.self, forKey: .text)
    guard isValid else { throw ConversationFailure.invalidResponse }
  }
}

public struct HistoryPage: Codable, Equatable, Sendable {
  public static let maximumMessages = 10
  public let messages: [ConversationMessage]
  public let nextAfter: Int?
  public init(messages: [ConversationMessage], nextAfter: Int?) {
    self.messages = messages
    self.nextAfter = nextAfter
  }
  private enum CodingKeys: String, CodingKey { case messages, nextAfter }
  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    messages = try container.decode([ConversationMessage].self, forKey: .messages)
    nextAfter = try container.decode(Int?.self, forKey: .nextAfter)
  }
  public func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(messages, forKey: .messages)
    try container.encode(nextAfter, forKey: .nextAfter)
  }
}

public enum ConversationFailure: Error, Equatable, Sendable {
  case invalidInput
  case invalidResponse
  case unavailable
  case rejected(code: String, message: String)
  case draftStorageUnavailable
}

public protocol ConversationTransport: Sendable {
  func send(_ delivery: PendingDelivery) async throws -> ConversationMessage
  func history(after: Int?) async throws -> HistoryPage
  func observeReply(for inputDeliveryId: UUID) async throws -> ReplyObservation
}

public enum SavedDraft: Codable, Equatable, Sendable {
  case editable(text: String)
  case awaitingReceipt(PendingDelivery)

  public var text: String {
    switch self {
    case .editable(let text): text
    case .awaitingReceipt(let delivery): delivery.text
    }
  }
  public var pending: PendingDelivery? {
    if case .awaitingReceipt(let delivery) = self { return delivery }
    return nil
  }
}

public protocol DraftStore: Sendable {
  func load() async throws -> SavedDraft
  func save(_ draft: SavedDraft) async throws
}

public actor MemoryDraftStore: DraftStore {
  private var value = SavedDraft.editable(text: "")
  public init() {}
  public func load() throws -> SavedDraft { value }
  public func save(_ draft: SavedDraft) throws { value = draft }
}
