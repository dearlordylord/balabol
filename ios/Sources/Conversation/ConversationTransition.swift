import Foundation

/// All intents and async results enter this concrete conversation transition.
/// Commands describe work; they do not execute it or acquire resources here.
enum ConversationEvent {
  case start
  case recoverDraft
  case edit(String)
  case send(UUID)
  case loadHistory(refresh: Bool)
  case draftLoaded(ConversationState.Request, Result<SavedDraft, ConversationFailure>)
  case draftSaved(ConversationState.Request, Result<Void, ConversationFailure>)
  case delivered(ConversationState.Request, Result<ConversationMessage, ConversationFailure>)
  case historyLoaded(ConversationState.Request, Result<HistoryPage, ConversationFailure>)
  case shutdown
  case drained
}

enum ConversationCommand {
  case loadDraft(ConversationState.Request)
  case saveDraft(ConversationState.Request, SavedDraft)
  case send(ConversationState.Request, PendingDelivery)
  case history(ConversationState.Request, Int?)
  case cancelSend
  case cancelHistory
}

extension ConversationState {
  mutating func transition(_ event: ConversationEvent) -> [ConversationCommand] {
    switch event {
    case .start:
      guard isActive, case .unloaded = draft else { return [] }
      let request = request()
      draft = .loading(request, previous: nil)
      return [.loadDraft(request)]
    case .recoverDraft:
      guard isActive, case .blocked(let previous, _) = draft else { return [] }
      if let previous {
        draft = .available(previous, .clean)
        if let commands = reconcilePending(previous) { return commands }
        return checkpoint(previous, purpose: previous.pending == nil ? .edit : .pending)
      }
      let request = request()
      draft = .loading(request, previous: nil)
      return [.loadDraft(request)]
    case .edit(let text):
      guard canEditDraft else { return [] }
      delivery = .idle(nil)
      return checkpoint(.editable(text: text), purpose: .edit)
    case .send(let identity):
      guard canSendDraft, case .available(let content, let persistence) = draft else { return [] }
      guard !content.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
        content.text.utf16.count <= 100_000
      else {
        delivery = .idle(.invalidInput)
        return []
      }
      let pending = content.pending ?? PendingDelivery(deliveryId: identity, text: content.text)
      delivery = .waitingCheckpoint(pending)
      if content.pending != nil, persistence == .clean { return beginSend(pending) }
      return checkpoint(.awaitingReceipt(pending), purpose: .pending)
    case .loadHistory(let refresh):
      guard isActive, !isLoadingHistory, refresh || !hasLoadedHistory || hasMoreHistory else {
        return []
      }
      let request = request()
      history = .loading(request, after: historyCursor)
      return [.history(request, historyCursor)]
    case .draftLoaded(let request, let result):
      guard isActive, case .loading(let expected, _) = draft, expected == request else { return [] }
      switch result {
      case .success(let saved):
        guard saved.pending.map({ !$0.text.isEmpty && $0.text.utf16.count <= 100_000 }) ?? true
        else {
          draft = .blocked(nil, .draftStorageUnavailable)
          return []
        }
        draft = .available(saved, .clean)
        if let commands = reconcilePending(saved) { return commands }
      case .failure(let error): draft = .blocked(nil, error)
      }
      return []
    case .draftSaved(let request, let result):
      return finishCheckpoint(request, result)
    case .delivered(let request, let result):
      guard isActive, case .sending(let expected, let pending) = delivery, expected == request
      else { return [] }
      switch result {
      case .success(let receipt):
        guard receipt.isValid, receipt.deliveryId == pending.deliveryId,
          receipt.text == pending.text,
          merge([receipt])
        else {
          delivery = .uncertain(pending, .invalidResponse)
          return []
        }
        delivery = .idle(nil)
        return checkpoint(.editable(text: ""), purpose: .confirmation)
      case .failure(let error):
        if case .rejected(let code, _) = error, ["InvalidInput", "DeliveryConflict"].contains(code)
        {
          delivery = .idle(error)
          return checkpoint(.editable(text: pending.text), purpose: .rejection)
        }
        delivery = .uncertain(pending, error)
        return []
      }
    case .historyLoaded(let request, let result):
      guard isActive, case .loading(let expected, let after) = history, expected == request else {
        return []
      }
      return finishHistory(result, after: after)
    case .shutdown:
      guard isActive else { return [] }
      // A changed generation invalidates network results. Draft completions
      // remain matched to their checkpoint until the serialized writer drains.
      if case .active(let generation) = connection {
        connection = .stopping(generation: generation + 1)
      }
      history = .idle
      if let pending = draft.content?.pending {
        delivery = .uncertain(pending, .unavailable)
      } else {
        delivery = .idle(nil)
      }
      if case .loading = draft { draft = .unloaded }
      return [.cancelSend, .cancelHistory]
    case .drained:
      guard case .stopping = connection else { return [] }
      connection = .stopped
      return []
    }
  }

  private mutating func request() -> Request {
    let generation: Int
    switch connection {
    case .active(let value), .stopping(let value): generation = value
    case .stopped: preconditionFailure("Stopped conversations cannot start work.")
    }
    nextRequestID += 1
    return Request(generation: generation, id: nextRequestID)
  }

  private mutating func checkpoint(_ value: SavedDraft, purpose: CheckpointPurpose)
    -> [ConversationCommand]
  {
    guard case .available(_, let persistence) = draft else { return [] }
    let checkpoint = Checkpoint(value: value, purpose: purpose)
    switch persistence {
    case .clean:
      let request = request()
      draft = .available(value, .writing(request, checkpoint, required: nil))
      return [.saveDraft(request, value)]
    case .writing(let request, let inFlight, let required):
      if purpose == .edit {
        draft = .available(value, .writing(request, inFlight, required: required))
      } else {
        // Input is frozen through protected checkpoints, bounding this queue to
        // one pending/terminal value. It cannot be replaced by newer typing.
        guard required == nil else { return [] }
        draft = .available(value, .writing(request, inFlight, required: checkpoint))
      }
      return []
    }
  }

  private mutating func finishCheckpoint(
    _ request: Request, _ result: Result<Void, ConversationFailure>
  ) -> [ConversationCommand] {
    guard case .available(let content, .writing(let expected, let written, let required)) = draft,
      expected == request
    else { return [] }
    switch result {
    case .failure(let error):
      draft = .blocked(content, error)
      return []
    case .success:
      draft = .available(content, .clean)
      if let required { return checkpoint(required.value, purpose: required.purpose) }
      if content != written.value { return checkpoint(content, purpose: .edit) }
      if let commands = reconcilePending(content) { return commands }
      if isActive, case .waitingCheckpoint(let pending) = delivery,
        content == .awaitingReceipt(pending)
      {
        return beginSend(pending)
      }
      return []
    }
  }

  private mutating func beginSend(_ pending: PendingDelivery) -> [ConversationCommand] {
    let request = request()
    delivery = .sending(request, pending)
    return [.send(request, pending)]
  }

  private mutating func finishHistory(
    _ result: Result<HistoryPage, ConversationFailure>, after: Int?
  ) -> [ConversationCommand] {
    switch result {
    case .failure(let error):
      history = .failed(error)
      return []
    case .success(let page):
      guard page.messages.count <= HistoryPage.maximumMessages,
        page.messages.allSatisfy(\.isValid),
        zip(page.messages, page.messages.dropFirst()).allSatisfy({ $0.position < $1.position }),
        page.messages.first.map({ $0.position > (after ?? -1) }) ?? true,
        page.nextAfter == nil || page.nextAfter == page.messages.last?.position
      else {
        history = .failed(.invalidResponse)
        return []
      }
      let accepted = draft.content?.pending.flatMap { pending in
        page.messages.first(where: { $0.deliveryId == pending.deliveryId })
      }
      if let accepted, accepted.text != draft.content?.text {
        history = .failed(.invalidResponse)
        return []
      }
      guard merge(page.messages) else {
        history = .failed(.invalidResponse)
        return []
      }
      history = .idle
      historyCursor = page.messages.last?.position ?? after
      hasLoadedHistory = true
      hasMoreHistory = page.nextAfter != nil
      if accepted != nil {
        delivery = .idle(nil)
        return [.cancelSend] + checkpoint(.editable(text: ""), purpose: .confirmation)
      }
      return []
    }
  }

  /// History may arrive before local loading or while a checkpoint is blocked.
  /// The confirmed projection remains evidence when the history cursor advances.
  private mutating func reconcilePending(_ content: SavedDraft) -> [ConversationCommand]? {
    guard let pending = content.pending,
      let accepted = messages.first(where: { $0.deliveryId == pending.deliveryId })
    else { return nil }
    guard accepted.text == pending.text else {
      delivery = .uncertain(pending, .invalidResponse)
      return []
    }
    delivery = .idle(nil)
    return [.cancelSend] + checkpoint(.editable(text: ""), purpose: .confirmation)
  }

  private mutating func merge(_ incoming: [ConversationMessage]) -> Bool {
    var merged = messages
    for message in incoming {
      if let existing = merged.first(where: { $0.deliveryId == message.deliveryId }) {
        guard existing == message else { return false }
      } else {
        guard
          !merged.contains(where: {
            $0.position == message.position || $0.recordId == message.recordId
          })
        else { return false }
        merged.append(message)
      }
    }
    messages = merged.sorted { $0.position < $1.position }
    return true
  }
}
