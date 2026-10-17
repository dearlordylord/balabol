import Foundation
import Observation

/// Native MVVM interpreter for this feature's concrete commands. Tasks are owned
/// here, not in the transition; request identities reject canceled/late results.
/// File work is serialized by DraftStore and at most one checkpoint task exists.
@MainActor @Observable
public final class ConversationViewModel {
  public private(set) var state = ConversationState()
  @ObservationIgnored private let transport: any ConversationTransport
  @ObservationIgnored internal let diagnosticsEnabled: Bool
  @ObservationIgnored private let draftStore: any DraftStore
  @ObservationIgnored private let inputIntent: @MainActor (UUID) -> Void
  @ObservationIgnored private var draftTask: Task<Void, Never>?
  @ObservationIgnored private var deliveryTask: Task<Void, Never>?
  @ObservationIgnored private var interruptionReceiptTasks:
    [ConversationState.Request: Task<Void, Never>] = [:]
  @ObservationIgnored private var platformStop: Task<Void, Never>?
  @ObservationIgnored private var platformTasks: [ConversationState.Request: Task<Void, Never>] =
    [:]
  @ObservationIgnored private var replyTask: Task<Void, Never>?
  @ObservationIgnored private var replyRequest: ConversationState.Request?
  @ObservationIgnored private var currentTask: Task<Void, Never>?
  @ObservationIgnored private var currentRequest: ConversationState.Request?
  @ObservationIgnored private var reconnectDisplayTask: Task<Void, Never>?
  @ObservationIgnored private var historyTask: Task<Void, Never>?
  @ObservationIgnored private var draftRequest: ConversationState.Request?
  @ObservationIgnored private var deliveryRequest: ConversationState.Request?
  @ObservationIgnored private var historyRequest: ConversationState.Request?

  public init(
    transport: any ConversationTransport, draftStore: any DraftStore,
    diagnosticsEnabled: Bool = false,
    inputIntent: @escaping @MainActor (UUID) -> Void = { _ in }
  ) {
    self.diagnosticsEnabled = diagnosticsEnabled
    self.transport = transport
    self.draftStore = draftStore
    self.inputIntent = inputIntent
  }

  public var canRetryReply: Bool { state.canRetryReply }
  public var replyText: String { state.replyText }
  public var replyIsWaiting: Bool { state.replyIsWaiting }
  public var isObservingReply: Bool { state.isObservingReply }
  public var replyProviderFailure: ReplyFailure? { state.replyProviderFailure }
  public var replyObservationFailure: ConversationFailure? { state.replyObservationFailure }
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
  public var nextBefore: Int? { state.nextBefore }
  public var draftFailure: ConversationFailure? { state.draftFailure }
  public var deliveryFailure: ConversationFailure? { state.deliveryFailure }
  public var historyFailure: ConversationFailure? { state.historyFailure }
  // Compatibility projection only; views render each lifecycle's error itself.
  public var failure: ConversationFailure? { draftFailure ?? deliveryFailure ?? historyFailure }

  /// A validated voice receipt adds one durable fact without touching draft or history cursor.
  public func acceptVoiceReceipt(_ receipt: ConversationMessage) {
    receive(.voiceAccepted(receipt))
    receive(.refreshCurrent)
  }

  public func interruptForPlatform(handedInputIds: [UUID], afterLocalStop: Task<Void, Never>? = nil)
  {
    platformStop = afterLocalStop
    receive(.platformInterrupt(handedInputIds))
  }
  /// Catch up bounded forward pages without consuming older pagination or touching draft.
  public func refreshReconnectDisplay() {
    receive(.refreshReconnectDisplay)
  }

  public func start() async {
    receive(.start)
    await flushDraft()
    receive(.refreshCurrent)
    if let task = currentTask { await task.value }
  }
  public func reloadDraft() async {
    receive(.recoverDraft)
    await flushDraft()
  }
  public func retryReply() async {
    receive(.retryReply)
    if let task = replyTask { await task.value }
  }
  public func editDraft(_ text: String) { receive(.edit(text)) }
  public func send() async {
    receive(.send(UUID()))
    await flushDraft()
    if let task = deliveryTask { await task.value }
    await flushDraft()
  }
  public func loadOlderHistory() async {
    await loadHistory()
  }
  public func loadHistory() async {
    receive(.loadHistory(refresh: false))
    while let task = historyTask { await task.value }
    if state.isSavingDraft { await flushDraft() }
  }
  /// Catch up all new rows, without consuming the independent older-history cursor.
  public func refreshHistory() async {
    receive(.refreshCurrent)
    receive(.loadHistory(refresh: true))
    while let task = historyTask { await task.value }
    if let task = currentTask { await task.value }
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
    for task in platformTasks.values { await task.value }
    platformTasks = [:]
    await flushDraft()
    receive(.drained)
  }

  private func receive(_ event: ConversationEvent) {
    let commands = state.transition(event)
    if diagnosticsEnabled, let failure = state.replyObservationFailure,
      case .observationFailed(let input, _, _) = state.reply
    {
      ReplyObservationDiagnostics.record(input: input, stage: "projection", failure: failure)
    }
    for command in commands { execute(command) }
  }

  private func execute(_ command: ConversationCommand) {
    switch command {
    case .cancelPlatformTargets(let requests):
      for request in requests { platformTasks.removeValue(forKey: request)?.cancel() }
    case .cancelPlatformInterruptions:
      for task in platformTasks.values { task.cancel() }
    case .findPlatformTarget(let request, let input):
      let stop = platformStop
      let transport = transport
      platformTasks[request]?.cancel()
      platformTasks[request] = Task { [weak self] in
        do {
          await stop?.value
          guard !Task.isCancelled else { return }
          let snapshot = try await transport.replySnapshot(for: input)
          guard !Task.isCancelled else { return }
          self?.platformTasks[request] = nil
          self?.receive(.platformTargetLoaded(request, input, snapshot))
        } catch {
          guard !Task.isCancelled else { return }
          self?.platformTasks[request] = nil
          self?.receive(.platformInterruptionFailed(request, input))
        }
      }
    case .interruptPlatformTarget(let request, let input, let response):
      let stop = platformStop
      let transport = transport
      platformTasks[request] = Task { [weak self] in
        do {
          await stop?.value
          guard !Task.isCancelled else { return }
          let snapshot = try await transport.interruptReply(
            responseId: response, inputDeliveryId: input)
          guard !Task.isCancelled else { return }
          self?.receive(.platformInterrupted(request, input, snapshot))
        } catch {
          guard !Task.isCancelled else { return }
          self?.receive(.platformInterruptionFailed(request, input))
        }
        self?.platformTasks[request] = nil
      }
    case .inputIntent(let id): inputIntent(id)
    case .current(let request):
      let transport = transport
      currentRequest = request
      currentTask = Task { [weak self] in
        let result: Result<CurrentTurn?, ConversationFailure>
        do { result = .success(try await transport.currentTurn()) } catch let error
          as ConversationFailure
        {
          result = .failure(error)
        } catch { result = .failure(.unavailable) }
        guard let self, self.currentRequest == request else { return }
        self.currentTask = nil
        self.currentRequest = nil
        self.receive(.currentLoaded(request, result))
      }
    case .retryReply(let request, let input):
      let transport = transport
      replyRequest = request
      replyTask = Task { [weak self] in
        let result: Result<ReplySnapshot, ConversationFailure>
        do { result = .success(try await transport.retryReply(for: input)) } catch let error
          as ConversationFailure
        {
          result = .failure(error)
        } catch { result = .failure(.unavailable) }
        guard let self, self.replyRequest == request else { return }
        self.replyTask = nil
        self.replyRequest = nil
        self.receive(.retryLoaded(request, result))
      }
    case .cancelCurrent:
      currentTask?.cancel()
      currentTask = nil
      currentRequest = nil
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
    case .reconnectDisplay(let request, let after):
      let transport = transport
      reconnectDisplayTask = Task { [weak self] in
        var cursor = after
        repeat {
          let result: Result<HistoryPage, ConversationFailure>
          do { result = .success(try await transport.history(after: cursor)) } catch {
            result = .failure(error as? ConversationFailure ?? .unavailable)
          }
          let current: Result<CurrentTurn?, ConversationFailure>
          if case .success(let page) = result, page.nextAfter != nil {
            current = .success(nil)
          } else {
            do { current = .success(try await transport.currentTurn()) } catch {
              current = .failure(error as? ConversationFailure ?? .unavailable)
            }
          }
          guard !Task.isCancelled, let self else { return }
          self.receive(.reconnectDisplayLoaded(request, result, current))
          guard self.state.reconnectDisplayRequest == request,
            case .success(let page) = result, let next = page.nextAfter
          else { break }
          cursor = next
        } while true
        self?.reconnectDisplayTask = nil
      }
    case .cancelReconnectDisplay:
      reconnectDisplayTask?.cancel()
      reconnectDisplayTask = nil
    case .history(let request, let after, let older):
      let transport = transport
      historyRequest = request
      historyTask = Task { [weak self] in
        let result: Result<HistoryPage, ConversationFailure>
        do {
          if older {
            let page = try await transport.olderHistory(before: after)
            result = .success(HistoryPage(messages: page.messages, nextAfter: page.nextBefore))
          } else {
            result = .success(try await transport.history(after: after))
          }
        } catch let failure
          as ConversationFailure
        { result = .failure(failure) } catch { result = .failure(.unavailable) }
        guard let self, self.historyRequest == request else { return }
        self.historyTask = nil
        self.historyRequest = nil
        self.receive(.historyLoaded(request, result))
      }
    case .observeReply(let request, let input):
      let transport = transport
      replyRequest = request
      replyTask = Task { [weak self] in
        let failure: ConversationFailure?
        do {
          let observation = try await transport.observeReply(for: input)
          defer { observation.cancel() }
          for try await snapshot in observation.events {
            guard let self, self.replyRequest == request else { return }
            self.receive(.replyReceived(request, snapshot))
            if self.replyRequest != request { return }
          }
          failure = nil
        } catch let error as ConversationFailure { failure = error } catch {
          failure = .unavailable
        }
        guard let self, self.replyRequest == request else { return }
        self.replyTask = nil
        self.replyRequest = nil
        self.receive(.replyEnded(request, failure))
      }
    case .recoverObservation(let request, let input, let attempt):
      let transport = transport
      let diagnosticsEnabled = diagnosticsEnabled
      replyRequest = request
      replyTask = Task { [weak self] in
        do { try await Task.sleep(for: .seconds(attempt)) } catch { return }
        let result: Result<ReplySnapshot, ConversationFailure>
        do { result = .success(try await transport.replySnapshot(for: input)) } catch let error
          as ConversationFailure
        { result = .failure(error) } catch { result = .failure(.unavailable) }
        guard let self, self.replyRequest == request else { return }
        self.replyTask = nil
        self.replyRequest = nil
        if diagnosticsEnabled {
          ReplyObservationDiagnostics.record(input: input, stage: "recovery", result: result)
        }
        self.receive(.observationRecovered(request, result))
      }
    case .recoverInterruptedReply(let request, let input):
      let transport = transport
      interruptionReceiptTasks[request] = Task { [weak self] in
        let result: Result<ReplySnapshot, ConversationFailure>
        do { result = .success(try await transport.replySnapshot(for: input)) } catch let error
          as ConversationFailure
        { result = .failure(error) } catch { result = .failure(.unavailable) }
        guard let self, self.interruptionReceiptTasks.removeValue(forKey: request) != nil else {
          return
        }
        self.receive(.interruptedReplyRecovered(request, result))
      }
    case .cancelInterruptionRecoveries:
      for task in interruptionReceiptTasks.values { task.cancel() }
      interruptionReceiptTasks.removeAll()
    case .cancelReply:
      replyTask?.cancel()
      replyTask = nil
      replyRequest = nil
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
