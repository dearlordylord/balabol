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
  public enum Outcome: String, Codable, Sendable { case completed, interrupted }
  public let outcome: Outcome?
  public let role: Role
  public let responseId: UUID?
  public let inputDeliveryId: UUID?
  public let deliveryId: UUID
  public let recordId: Int
  public let position: Int
  public let text: String
  public let detectedLanguage: String?
  public let responseLanguage: String?
  public let languageSpans: [LanguageSpan]
  public var id: UUID { deliveryId }
  public var isValid: Bool {
    guard
      recordId >= 0 && position >= 0 && (!text.isEmpty || outcome == .interrupted)
        && text.utf16.count <= 100_000 && LanguageSpan.areValid(languageSpans, for: text)
        && (detectedLanguage.map(LanguageSpan.isValidLanguageTag) ?? true)
        && (responseLanguage.map(LanguageSpan.isValidLanguageTag) ?? true)
    else {
      return false
    }
    switch role {
    case .user: return responseId == nil && inputDeliveryId == nil && outcome == nil
    case .assistant:
      return outcome != nil && responseId == deliveryId && inputDeliveryId != nil
        && inputDeliveryId != deliveryId
    }
  }
  public init(
    deliveryId: UUID, recordId: Int, position: Int, text: String, role: Role = .user,
    responseId: UUID? = nil, inputDeliveryId: UUID? = nil, outcome: Outcome? = nil,
    languageSpans: [LanguageSpan] = [], detectedLanguage: String? = nil,
    responseLanguage: String? = nil
  ) {
    self.role = role
    self.outcome = role == .assistant ? outcome ?? .completed : outcome
    self.responseId = responseId
    self.inputDeliveryId = inputDeliveryId
    self.deliveryId = deliveryId
    self.recordId = recordId
    self.position = position
    self.text = text
    self.languageSpans = languageSpans
    self.detectedLanguage = detectedLanguage
    self.responseLanguage = responseLanguage
  }
  private enum CodingKeys: String, CodingKey {
    case deliveryId, recordId, position, text, role, responseId, inputDeliveryId, outcome,
      languageSpans, detectedLanguage, responseLanguage
  }
  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    role = try container.decodeIfPresent(Role.self, forKey: .role) ?? .user
    outcome =
      container.contains(.outcome)
      ? try container.decode(Outcome.self, forKey: .outcome)
      : (role == .assistant ? .completed : nil)
    responseId = try container.decodeIfPresent(UUID.self, forKey: .responseId)
    inputDeliveryId = try container.decodeIfPresent(UUID.self, forKey: .inputDeliveryId)
    deliveryId = try container.decode(UUID.self, forKey: .deliveryId)
    recordId = try container.decode(Int.self, forKey: .recordId)
    position = try container.decode(Int.self, forKey: .position)
    text = try container.decode(String.self, forKey: .text)
    detectedLanguage = try container.decodeIfPresent(String.self, forKey: .detectedLanguage)
    responseLanguage = try container.decodeIfPresent(String.self, forKey: .responseLanguage)
    languageSpans =
      container.contains(.languageSpans)
      ? try container.decode([LanguageSpan].self, forKey: .languageSpans) : []
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

/// Latest window, ordered chronologically; the exclusive cursor walks into the past.
public struct OlderHistoryPage: Codable, Equatable, Sendable {
  public static let maximumMessages = 100
  public let messages: [ConversationMessage]
  public let nextBefore: Int?
  public init(messages: [ConversationMessage], nextBefore: Int?) {
    self.messages = messages
    self.nextBefore = nextBefore
  }
  private enum CodingKeys: String, CodingKey { case messages, nextBefore }
  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    messages = try container.decode([ConversationMessage].self, forKey: .messages)
    nextBefore = try container.decode(Int?.self, forKey: .nextBefore)
  }
  public func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(messages, forKey: .messages)
    try container.encode(nextBefore, forKey: .nextBefore)
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
  func interruptReply(responseId: UUID, inputDeliveryId: UUID) async throws -> ReplySnapshot?
  func currentTurn() async throws -> CurrentTurn?
  func retryReply(for inputDeliveryId: UUID) async throws -> ReplySnapshot
  func send(_ delivery: PendingDelivery) async throws -> ConversationMessage
  func olderHistory(before: Int?) async throws -> OlderHistoryPage
  func history(after: Int?) async throws -> HistoryPage
  func replySnapshot(for inputDeliveryId: UUID) async throws -> ReplySnapshot
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

extension ConversationTransport {
  public func interruptReply(responseId: UUID, inputDeliveryId: UUID) async throws -> ReplySnapshot?
  {
    throw ConversationFailure.unavailable
  }
}
