import Foundation

/// Feature-local state: the server owns acceptance/order; the client owns its
/// checkpoint and independent delivery/history work. Follow Event → transitionConversation
/// → Command → ViewModel-owned task → completion Event for every mutation.
/// Keep this feature-specific; before shared effect/task/testing infrastructure,
/// review the TCA adoption condition in docs/engineering/ownership.md.
public struct ConversationState: Equatable, Sendable {
  public enum Connection: Equatable, Sendable {
    case active(generation: Int)
    case stopping(generation: Int)
    case stopped
  }
  public struct Request: Hashable, Sendable {
    public let generation: Int
    public let id: Int
  }
  public enum CheckpointPurpose: Equatable, Sendable {
    case edit, pending, confirmation, rejection
  }
  public struct Checkpoint: Equatable, Sendable {
    public let value: SavedDraft
    public let purpose: CheckpointPurpose
  }
  public enum Persistence: Equatable, Sendable {
    case clean
    // Only obsolete editable values coalesce. A queued pending/terminal
    // checkpoint is retained independently and must finish before more input.
    case writing(Request, Checkpoint, required: Checkpoint?)
  }
  public enum Draft: Equatable, Sendable {
    case unloaded
    case loading(Request, previous: SavedDraft?)
    case available(SavedDraft, Persistence)
    case blocked(SavedDraft?, ConversationFailure)

    public var content: SavedDraft? {
      switch self {
      case .unloaded: nil
      case .loading(_, let previous), .blocked(let previous, _): previous
      case .available(let content, _): content
      }
    }
  }
  public enum Delivery: Equatable, Sendable {
    case idle(ConversationFailure?)
    case waitingCheckpoint(PendingDelivery)
    case sending(Request, PendingDelivery)
    case uncertain(PendingDelivery, ConversationFailure)
  }
  public enum History: Equatable, Sendable {
    case idle
    case loading(Request, after: Int?, older: Bool)
    case failed(ConversationFailure)
  }

  // At most one displayed input plus two already handed voice finals. This
  // cancellation fence is independent of draft, Memory and reply observation.
  internal struct PlatformCancellation: Equatable, Sendable {
    let request: Request
    var responseId: UUID?
  }
  internal var platformCancellations: [UUID: PlatformCancellation] = [:]
  public enum Reply: Equatable, Sendable {
    case idle
    case observing(Request, inputDeliveryId: UUID, latest: ReplySnapshot?)
    case recovering(Request, inputDeliveryId: UUID, latest: ReplySnapshot?, attempt: Int)
    case completed(ConversationMessage)
    case providerFailed(
      inputDeliveryId: UUID, text: String, ReplyFailure, languageSpans: [LanguageSpan] = [])
    case observationFailed(inputDeliveryId: UUID, latest: ReplySnapshot?, ConversationFailure)
  }
  public var replyHasSnapshot: Bool {
    if case .observing(_, _, let latest) = reply { return latest != nil }
    return false
  }
  // Only one fresh accepted input may produce progress sounds; restoration never arms it.
  internal var cueInput: UUID?
  internal var cueResponse: UUID?
  internal var cueStage = 0
  internal var cueRetrySequence = -1
  internal var observationRecoveryAttempt = 0
  internal var replyRetryRequest: Request?
  public var isRetryingReply: Bool { replyRetryRequest != nil }
  internal var currentRequest: Request?
  public internal(set) var currentFailure: ConversationFailure?
  public var canRetryReply: Bool {
    guard isActive, !isSending, case .available(.editable, _) = draft,
      case .providerFailed(let input, _, _, _) = reply
    else { return false }
    return messages.last(where: { $0.role == .user })?.deliveryId == input
      && !messages.contains(where: { $0.role == .assistant && $0.inputDeliveryId == input })
  }
  public internal(set) var reply: Reply = .idle
  public var replyLanguageSpans: [LanguageSpan] {
    switch reply {
    case .observing(_, _, let latest), .recovering(_, _, let latest, _),
      .observationFailed(_, let latest, _):
      latest?.languageSpans ?? []
    case .providerFailed(_, _, _, let spans): spans
    case .completed(let receipt): receipt.languageSpans
    case .idle: []
    }
  }
  public var replyText: String {
    switch reply {
    case .observing(_, _, let latest), .recovering(_, _, let latest, _),
      .observationFailed(_, let latest, _):
      latest?.text ?? ""
    case .providerFailed(_, let text, _, _): text
    default: ""
    }
  }
  public var isObservingReply: Bool {
    if case .observing = reply { return true }
    return false
  }
  public var replyIsWaiting: Bool {
    if case .observing(_, _, let latest) = reply {
      return latest == nil || latest?.state == .waiting || latest?.retry != nil
    }
    return false
  }
  public var replyRetryProgress: ReplyRetryProgress? {
    if case .observing(_, _, let latest) = reply { return latest?.retry }
    return nil
  }
  public var replyProviderFailure: ReplyFailure? {
    if case .providerFailed(_, _, let error, _) = reply { return error }
    return nil
  }
  public var isRecoveringReply: Bool {
    if case .recovering = reply { return true }
    return false
  }
  public var replyObservationFailure: ConversationFailure? {
    if case .observationFailed(_, _, let error) = reply { return error }
    return nil
  }

  public internal(set) var connection: Connection = .active(generation: Int())
  internal var nextRequestID = 0
  // At most two terminal receipt reads can overlap. A stalled backend applies
  // honest send backpressure while the editable draft remains locally saved.
  public static let maximumInterruptionRecoveries = 2
  public var isWaitingForInterruptionRecovery: Bool {
    interruptionRecoveries.count >= Self.maximumInterruptionRecoveries
  }
  internal var interruptedInput: UUID?
  internal var interruptionRecoveries: [Request: UUID] = [:]
  public internal(set) var interruptedReceiptFailure: ConversationFailure?
  public internal(set) var draft: Draft = .unloaded
  public internal(set) var delivery: Delivery = .idle(nil)
  public internal(set) var history: History = .idle
  public internal(set) var messages: [ConversationMessage] = []
  // This cursor advances only when a server history page is accepted. A direct
  // receipt can jump ahead of missing rows and therefore must never advance it.
  internal var reconnectDisplayRequest: Request?
  internal var reconnectDisplayAfter: Int?
  public internal(set) var reconnectDisplayFailure: ConversationFailure?
  internal var historyRefreshPending = false
  public internal(set) var nextBefore: Int?
  public internal(set) var historyCursor: Int?
  public internal(set) var hasLoadedHistory = false
  public internal(set) var hasMoreHistory = false

  public var draftText: String { draft.content?.text ?? "" }
  public var pendingDelivery: PendingDelivery? { draft.content?.pending }
  public var draftFailure: ConversationFailure? {
    if case .blocked(_, let failure) = draft { return failure }
    return nil
  }
  public var deliveryFailure: ConversationFailure? {
    switch delivery {
    case .idle(let failure): failure
    case .uncertain(_, let failure): failure
    default: nil
    }
  }
  public var historyFailure: ConversationFailure? {
    if case .failed(let failure) = history { return failure }
    return nil
  }
  public var isActive: Bool {
    if case .active = connection { return true }
    return false
  }
  public var isSending: Bool {
    switch delivery {
    case .waitingCheckpoint, .sending: true
    default: false
    }
  }
  public var isLoadingHistory: Bool {
    if case .loading = history { return true }
    return false
  }
  public var isSavingDraft: Bool {
    if case .available(_, .writing) = draft { return true }
    return false
  }
  public var canEditDraft: Bool {
    guard isActive, !isSending, case .available(.editable, let persistence) = draft else {
      return false
    }
    switch persistence {
    case .clean: return true
    case .writing(_, let checkpoint, let required):
      return checkpoint.purpose == .edit && required == nil
    }
  }
  public var canSendDraft: Bool {
    guard isActive, !isSending, !isWaitingForInterruptionRecovery,
      case .available(_, let persistence) = draft
    else { return false }
    switch persistence {
    case .clean: return true
    case .writing(_, let checkpoint, let required):
      return checkpoint.purpose == .edit && required == nil
    }
  }
  public var canSwitchServer: Bool {
    guard isActive, !isSending, case .available(.editable, .clean) = draft else { return false }
    return true
  }
}
