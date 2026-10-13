import Foundation

/// Feature-local state: the server owns acceptance/order; the client owns its
/// checkpoint and independent delivery/history work. Follow Event → transition
/// → Command → ViewModel-owned task → completion Event for every mutation.
/// Keep this feature-specific; before shared effect/task/testing infrastructure,
/// review the TCA adoption condition in docs/engineering/ownership.md.
public struct ConversationState: Equatable, Sendable {
  public enum Connection: Equatable, Sendable {
    case active(generation: Int)
    case stopping(generation: Int)
    case stopped
  }
  public struct Request: Equatable, Sendable {
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
    case loading(Request, after: Int?)
    case failed(ConversationFailure)
  }

  public internal(set) var connection: Connection = .active(generation: Int())
  internal var nextRequestID = 0
  public internal(set) var draft: Draft = .unloaded
  public internal(set) var delivery: Delivery = .idle(nil)
  public internal(set) var history: History = .idle
  public internal(set) var messages: [ConversationMessage] = []
  // This cursor advances only when a server history page is accepted. A direct
  // receipt can jump ahead of missing rows and therefore must never advance it.
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
    guard isActive, !isSending, case .available(_, let persistence) = draft else { return false }
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
