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
  public let reason: String?
  public let message: String
  public var isValid: Bool {
    !message.isEmpty && message.utf16.count <= 1000
      && (reason.map { !$0.isEmpty && $0.utf16.count <= 100 } ?? true)
  }
  public init(code: Code, message: String, reason: String? = nil) {
    self.reason = reason
    self.code = code
    self.message = message
  }
}

/// Provider attempt progress is ephemeral and belongs to one response identity.
public struct ReplyRetryProgress: Codable, Equatable, Sendable {
  public let attempt: Int
  public let maximumAttempts: Int
  public var isValid: Bool { maximumAttempts == 3 && (2...maximumAttempts).contains(attempt) }
  public init(attempt: Int, maximumAttempts: Int) {
    self.attempt = attempt
    self.maximumAttempts = maximumAttempts
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
  public let languageSpans: [LanguageSpan]
  public let responseLanguage: String?
  public let retry: ReplyRetryProgress?
  public let generationStarted: Bool
  public let generationCompleted: Bool
  public var isTerminal: Bool { state == .completed || state == .interrupted || state == .failed }
  public var isValid: Bool {
    guard retry.map({ $0.isValid && (state == .waiting || state == .streaming) && !generationCompleted }) ?? true else { return false }
    guard !generationCompleted || generationStarted else { return false }
    guard sequence >= 0, responseId != inputDeliveryId, text.utf16.count <= 100_000,
      LanguageSpan.areValid(languageSpans, for: text),
      responseLanguage.map(LanguageSpan.isValidLanguageTag) ?? true
    else {
      return false
    }
    switch state {
    case .waiting: return text.isEmpty && error == nil && receipt == nil
    case .streaming, .delivering: return !text.isEmpty && error == nil && receipt == nil
    case .failed:
      guard let error, error.isValid else { return false }
      guard let receipt else { return true }
      return receipt.isValid && receipt.failure == error && receipt.outcome == .interrupted
        && receipt.deliveryId == responseId && receipt.inputDeliveryId == inputDeliveryId
        && receipt.text == text && receipt.languageSpans == languageSpans
    case .completed, .interrupted:
      return error == nil
        && receipt.map {
          $0.failure == nil && $0.isValid && $0.role == .assistant && $0.deliveryId == responseId
            && $0.responseId == responseId && $0.inputDeliveryId == inputDeliveryId
            && $0.text == text && $0.languageSpans == languageSpans
            && $0.outcome == (state == .interrupted ? .interrupted : .completed)
        } == true
    }
  }
  public init(
    responseId: UUID, inputDeliveryId: UUID, sequence: Int, state: Phase, text: String,
    error: ReplyFailure? = nil, receipt: ConversationMessage? = nil,
    languageSpans: [LanguageSpan] = [], responseLanguage: String? = nil,
    generationStarted: Bool = false, generationCompleted: Bool = false,
    retry: ReplyRetryProgress? = nil
  ) {
    self.retry = retry
    self.responseId = responseId
    self.inputDeliveryId = inputDeliveryId
    self.sequence = sequence
    self.state = state
    self.text = text
    self.error = error
    self.receipt = receipt
    self.languageSpans = languageSpans
    self.responseLanguage = responseLanguage
    self.generationStarted = generationStarted
    self.generationCompleted = generationCompleted
  }
  private enum CodingKeys: String, CodingKey {
    case responseId, inputDeliveryId, sequence, state, text, error, receipt, languageSpans,
      responseLanguage, generationStarted, generationCompleted, retry
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
    try c.encode(languageSpans, forKey: .languageSpans)
    try c.encodeIfPresent(responseLanguage, forKey: .responseLanguage)
    try c.encodeIfPresent(retry, forKey: .retry)
    try c.encode(generationStarted, forKey: .generationStarted)
    try c.encode(generationCompleted, forKey: .generationCompleted)
  }
  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    retry = try c.decodeIfPresent(ReplyRetryProgress.self, forKey: .retry)
    responseId = try c.decode(UUID.self, forKey: .responseId)
    inputDeliveryId = try c.decode(UUID.self, forKey: .inputDeliveryId)
    sequence = try c.decode(Int.self, forKey: .sequence)
    state = try c.decode(Phase.self, forKey: .state)
    text = try c.decode(String.self, forKey: .text)
    error = try c.decode(ReplyFailure?.self, forKey: .error)
    receipt = try c.decode(ConversationMessage?.self, forKey: .receipt)
    languageSpans =
      c.contains(.languageSpans)
      ? try c.decode([LanguageSpan].self, forKey: .languageSpans) : []
    responseLanguage = try c.decodeIfPresent(String.self, forKey: .responseLanguage)
    generationStarted = try c.decodeIfPresent(Bool.self, forKey: .generationStarted) ?? false
    generationCompleted = try c.decodeIfPresent(Bool.self, forKey: .generationCompleted) ?? false
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
