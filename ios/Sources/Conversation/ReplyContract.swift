import Foundation

public struct ReplyFailure: Codable, Equatable, Sendable {
  public enum Code: String, Codable, Sendable {
    case memoryPending = "MemoryPending"
    case memoryFailed = "MemoryFailed"
    case providerFailed = "ProviderFailed"
    case invalidProviderStream = "InvalidProviderStream"
    case storageUnavailable = "StorageUnavailable"
    case restarted = "Restarted"
    case cancelled = "Cancelled"
    case audioUnavailable = "AudioUnavailable"
  }
  public let code: Code
  public let message: String
  public init(code: Code, message: String) {
    self.code = code
    self.message = message
  }
}

/// Full snapshots replace projected text. Sequence gaps are permitted because
/// the bounded server observer may coalesce snapshots; missing text is not lost.
public struct ReplySnapshot: Codable, Equatable, Sendable {
  public enum Phase: String, Codable, Sendable {
    case waiting = "Waiting"
    case streaming = "Streaming"
    case delivering = "Delivering"
    case completed = "Completed"
    case interrupted = "Interrupted"
    case failed = "Failed"
  }
  public let responseId: UUID
  public let inputDeliveryId: UUID
  public let sequence: Int
  public let state: Phase
  public let text: String
  public let error: ReplyFailure?
  public let receipt: ConversationMessage?
  public var isTerminal: Bool { state == .completed || state == .interrupted || state == .failed }
  public var isValid: Bool {
    guard sequence >= 0, responseId != inputDeliveryId, text.utf16.count <= 100_000 else {
      return false
    }
    switch state {
    case .waiting: return text.isEmpty && error == nil && receipt == nil
    case .streaming, .delivering: return !text.isEmpty && error == nil && receipt == nil
    case .failed: return error.map { !$0.code.rawValue.isEmpty } == true && receipt == nil
    case .completed, .interrupted:
      return error == nil
        && receipt.map {
          $0.isValid && $0.role == .assistant && $0.deliveryId == responseId
            && $0.responseId == responseId && $0.inputDeliveryId == inputDeliveryId
            && $0.text == text && $0.outcome == (state == .interrupted ? .interrupted : .completed)
        } == true
    }
  }
  public init(
    responseId: UUID, inputDeliveryId: UUID, sequence: Int, state: Phase, text: String,
    error: ReplyFailure? = nil, receipt: ConversationMessage? = nil
  ) {
    self.responseId = responseId
    self.inputDeliveryId = inputDeliveryId
    self.sequence = sequence
    self.state = state
    self.text = text
    self.error = error
    self.receipt = receipt
  }
  private enum CodingKeys: String, CodingKey {
    case responseId, inputDeliveryId, sequence, state, text, error, receipt
  }
  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(responseId, forKey: .responseId)
    try c.encode(inputDeliveryId, forKey: .inputDeliveryId)
    try c.encode(sequence, forKey: .sequence)
    try c.encode(state, forKey: .state)
    try c.encode(text, forKey: .text)
    try c.encode(error, forKey: .error)
    try c.encode(receipt, forKey: .receipt)
  }
  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    responseId = try c.decode(UUID.self, forKey: .responseId)
    inputDeliveryId = try c.decode(UUID.self, forKey: .inputDeliveryId)
    sequence = try c.decode(Int.self, forKey: .sequence)
    state = try c.decode(Phase.self, forKey: .state)
    text = try c.decode(String.self, forKey: .text)
    error = try c.decode(ReplyFailure?.self, forKey: .error)
    receipt = try c.decode(ConversationMessage?.self, forKey: .receipt)
    guard isValid else { throw ConversationFailure.invalidResponse }
  }
}

/// Explicit observer lifetime. Closing it cancels the phone's HTTP reader, not
/// the memory host. The server owns its response-lease cancellation policy.
public struct ReplyObservation: Sendable {
  public let events: AsyncThrowingStream<ReplySnapshot, any Error>
  public let cancel: @Sendable () -> Void
  public init(
    events: AsyncThrowingStream<ReplySnapshot, any Error>, cancel: @escaping @Sendable () -> Void
  ) {
    self.events = events
    self.cancel = cancel
  }
}

extension ConversationTransport {
  public func currentTurn() async throws -> CurrentTurn? { throw ConversationFailure.unavailable }
  public func retryReply(for inputDeliveryId: UUID) async throws -> ReplySnapshot {
    throw ConversationFailure.unavailable
  }
  public func replySnapshot(for inputDeliveryId: UUID) async throws -> ReplySnapshot {
    throw ConversationFailure.unavailable
  }
  public func observeReply(for inputDeliveryId: UUID) async throws -> ReplyObservation {
    throw ConversationFailure.unavailable
  }
}

/// One bounded authoritative turn, independent of transcript pagination.
public struct CurrentTurn: Codable, Equatable, Sendable {
  public let input: ConversationMessage
  public let reply: ReplySnapshot
  public var isValid: Bool {
    input.isValid && input.role == .user && reply.isValid
      && reply.inputDeliveryId == input.deliveryId
      && (reply.receipt.map { $0.position > input.position } ?? true)
  }
  public init(input: ConversationMessage, reply: ReplySnapshot) {
    self.input = input
    self.reply = reply
  }
  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    input = try c.decode(ConversationMessage.self, forKey: .input)
    reply = try c.decode(ReplySnapshot.self, forKey: .reply)
    guard isValid else { throw ConversationFailure.invalidResponse }
  }
}
