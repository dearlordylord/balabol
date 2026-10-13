import Foundation
import Observation

/// Native MVVM interpreter for this feature's concrete commands. Tasks are owned
/// here, not in the transition; request identities reject canceled/late results.
/// File work is serialized by DraftStore and at most one checkpoint task exists.
@MainActor @Observable
public final class ConversationViewModel {
  public private(set) var state = ConversationState()
  @ObservationIgnored private let transport: any ConversationTransport
  @ObservationIgnored private let draftStore: any DraftStore
  @ObservationIgnored private var draftTask: Task<Void, Never>?
  @ObservationIgnored private var deliveryTask: Task<Void, Never>?
  @ObservationIgnored private var historyTask: Task<Void, Never>?
  @ObservationIgnored private var draftRequest: ConversationState.Request?
  @ObservationIgnored private var deliveryRequest: ConversationState.Request?
  @ObservationIgnored private var historyRequest: ConversationState.Request?

  public init(transport: any ConversationTransport, draftStore: any DraftStore) {
    self.transport = transport
    self.draftStore = draftStore
  }

  public var messages: [ConversationMessage] { state.messages }
  public var draft: String { state.draftText }
  public var pendingDelivery: PendingDelivery? { state.pendingDelivery }
  public var isSending: Bool { state.isSending }
  public var isLoading: Bool { state.isLoadingHistory }
  public var isSavingDraft: Bool { state.isSavingDraft }
  public var draftStorageReady: Bool {
    if case .available = state.draft { return true }
    return false
  }
  public var canSendDraft: Bool { state.canSendDraft }
  public var canEditDraft: Bool { state.canEditDraft }
  public var canSwitchServer: Bool { state.canSwitchServer }
  public var hasLoadedHistory: Bool { state.hasLoadedHistory }
  public var nextAfter: Int? { state.hasMoreHistory ? state.historyCursor : nil }
  public var draftFailure: ConversationFailure? { state.draftFailure }
  public var deliveryFailure: ConversationFailure? { state.deliveryFailure }
  public var historyFailure: ConversationFailure? { state.historyFailure }
  // Compatibility projection only; views render each lifecycle's error itself.
  public var failure: ConversationFailure? { draftFailure ?? deliveryFailure ?? historyFailure }

  public func start() async {
    receive(.start)
    await flushDraft()
  }
  public func reloadDraft() async {
    receive(.recoverDraft)
    await flushDraft()
  }
  public func editDraft(_ text: String) { receive(.edit(text)) }
  public func send() async {
    receive(.send(UUID()))
    await flushDraft()
    if let task = deliveryTask { await task.value }
    await flushDraft()
  }
  public func loadHistory() async {
    receive(.loadHistory(refresh: false))
    if let task = historyTask { await task.value }
    if state.isSavingDraft { await flushDraft() }
  }
  /// One page per foreground/explicit refresh, including after an earlier EOF.
  /// Further pages remain an explicit Load more intent rather than an auto drain.
  public func refreshHistory() async {
    receive(.loadHistory(refresh: true))
    if let task = historyTask { await task.value }
    if state.isSavingDraft { await flushDraft() }
  }
  /// A foreground/background owner can await local durability without shutting
  /// down the conversation. This includes already queued protected checkpoints.
  public func flushDraft() async {
    while let task = draftTask { await task.value }
  }
  /// Explicit replacement owns shutdown. It cancels network work, denies new
  /// intents immediately, and waits for existing local checkpoints to quiesce.
  public func shutdown() async {
    receive(.shutdown)
    await flushDraft()
    receive(.drained)
  }

  private func receive(_ event: ConversationEvent) {
    let commands = state.transition(event)
    for command in commands { execute(command) }
  }

  private func execute(_ command: ConversationCommand) {
    switch command {
    case .loadDraft(let request):
      let store = draftStore
      draftRequest = request
      draftTask = Task { [weak self] in
        let result: Result<SavedDraft, ConversationFailure>
        do { result = .success(try await store.load()) } catch {
          result = .failure(.draftStorageUnavailable)
        }
        self?.finishDraft(request, event: .draftLoaded(request, result))
      }
    case .saveDraft(let request, let checkpoint):
      let store = draftStore
      draftRequest = request
      draftTask = Task { [weak self] in
        let result: Result<Void, ConversationFailure>
        do {
          try await store.save(checkpoint)
          result = .success(())
        } catch { result = .failure(.draftStorageUnavailable) }
        self?.finishDraft(request, event: .draftSaved(request, result))
      }
    case .send(let request, let pending):
      let transport = transport
      deliveryRequest = request
      deliveryTask = Task { [weak self] in
        let result: Result<ConversationMessage, ConversationFailure>
        do { result = .success(try await transport.send(pending)) } catch let failure
          as ConversationFailure
        { result = .failure(failure) } catch { result = .failure(.unavailable) }
        guard let self, self.deliveryRequest == request else { return }
        self.deliveryTask = nil
        self.deliveryRequest = nil
        self.receive(.delivered(request, result))
      }
    case .history(let request, let after):
      let transport = transport
      historyRequest = request
      historyTask = Task { [weak self] in
        let result: Result<HistoryPage, ConversationFailure>
        do { result = .success(try await transport.history(after: after)) } catch let failure
          as ConversationFailure
        { result = .failure(failure) } catch { result = .failure(.unavailable) }
        guard let self, self.historyRequest == request else { return }
        self.historyTask = nil
        self.historyRequest = nil
        self.receive(.historyLoaded(request, result))
      }
    case .cancelSend:
      deliveryTask?.cancel()
      deliveryTask = nil
      deliveryRequest = nil
    case .cancelHistory:
      historyTask?.cancel()
      historyTask = nil
      historyRequest = nil
    }
  }

  private func finishDraft(_ request: ConversationState.Request, event: ConversationEvent) {
    guard draftRequest == request else { return }
    draftTask = nil
    draftRequest = nil
    receive(event)
  }
}
