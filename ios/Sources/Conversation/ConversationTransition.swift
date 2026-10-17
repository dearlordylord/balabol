import Foundation

/// All intents and async results enter this concrete conversation transition.
/// Commands describe work; they do not execute it or acquire resources here.
enum ConversationEvent {
  case start
  case platformInterrupt([UUID])
  case platformTargetLoaded(ConversationState.Request, UUID, ReplySnapshot?)
  case platformInterrupted(ConversationState.Request, UUID, ReplySnapshot?)
  case platformInterruptionFailed(ConversationState.Request, UUID)
  case voiceAccepted(ConversationMessage)
  case refreshReconnectDisplay
  case reconnectDisplayLoaded(
    ConversationState.Request, Result<HistoryPage, ConversationFailure>,
    Result<CurrentTurn?, ConversationFailure>)
  case refreshCurrent
  case retryReply
  case currentLoaded(ConversationState.Request, Result<CurrentTurn?, ConversationFailure>)
  case retryLoaded(ConversationState.Request, Result<ReplySnapshot, ConversationFailure>)
  case recoverDraft
  case edit(String)
  case send(UUID)
  case loadHistory(refresh: Bool)
  case draftLoaded(ConversationState.Request, Result<SavedDraft, ConversationFailure>)
  case draftSaved(ConversationState.Request, Result<Void, ConversationFailure>)
  case delivered(ConversationState.Request, Result<ConversationMessage, ConversationFailure>)
  case historyLoaded(ConversationState.Request, Result<HistoryPage, ConversationFailure>)
  case replyReceived(ConversationState.Request, ReplySnapshot)
  case interruptedReplyRecovered(
    ConversationState.Request, Result<ReplySnapshot, ConversationFailure>)
  case observationRecovered(ConversationState.Request, Result<ReplySnapshot, ConversationFailure>)
  case replyEnded(ConversationState.Request, ConversationFailure?)
  case shutdown
  case drained
}

enum ConversationCommand {
  case inputIntent(UUID)
  case findPlatformTarget(ConversationState.Request, UUID)
  case interruptPlatformTarget(ConversationState.Request, UUID, UUID)
  case cancelPlatformInterruptions
  case cancelPlatformTargets([ConversationState.Request])
  case current(ConversationState.Request)
  case retryReply(ConversationState.Request, UUID)
  case cancelCurrent
  case loadDraft(ConversationState.Request)
  case saveDraft(ConversationState.Request, SavedDraft)
  case send(ConversationState.Request, PendingDelivery)
  case reconnectDisplay(ConversationState.Request, Int?)
  case cancelReconnectDisplay
  case history(ConversationState.Request, Int?, older: Bool)
  case observeReply(ConversationState.Request, UUID)
  case recoverObservation(ConversationState.Request, UUID, Int)
  case recoverInterruptedReply(ConversationState.Request, UUID)
  case cancelInterruptionRecoveries
  case cancelReply
  case cancelSend
  case cancelHistory
}

extension ConversationState {
  mutating func transition(_ event: ConversationEvent) -> [ConversationCommand] {
    switch event {
    case .platformInterrupt, .platformTargetLoaded, .platformInterrupted,
      .platformInterruptionFailed:
      return platformInterruptionTransition(event)
    case .voiceAccepted(let receipt):
      guard isActive, receipt.isValid, receipt.role == .user, merge([receipt]) else { return [] }
      if let target = platformCancellations[receipt.deliveryId] {
        return [.findPlatformTarget(target.request, receipt.deliveryId)]
      }
      return []
    case .start:
      guard isActive, case .unloaded = draft else { return [] }
      let request = request()
      draft = .loading(request, previous: nil)
      return [.loadDraft(request)]
    case .refreshReconnectDisplay:
      guard isActive, hasLoadedHistory, reconnectDisplayRequest == nil else { return [] }
      let request = request()
      reconnectDisplayRequest = request
      reconnectDisplayAfter = historyCursor
      return [.reconnectDisplay(request, reconnectDisplayAfter)]
    case .reconnectDisplayLoaded(let request, let result, let current):
      guard isActive, reconnectDisplayRequest == request else { return [] }
      let after = reconnectDisplayAfter
      switch result {
      case .failure(let failure):
        reconnectDisplayRequest = nil
        reconnectDisplayFailure = failure
      case .success(let page):
        guard page.messages.count <= HistoryPage.maximumMessages,
          page.messages.allSatisfy(\.isValid),
          zip(page.messages, page.messages.dropFirst()).allSatisfy({ $0.position < $1.position }),
          page.nextAfter == nil || page.nextAfter == page.messages.last?.position,
          page.messages.first.map({ $0.position > (after ?? -1) }) ?? true,
          merge(page.messages)
        else {
          reconnectDisplayRequest = nil
          reconnectDisplayFailure = .invalidResponse
          return []
        }
        historyCursor = [historyCursor, page.messages.last?.position, after].compactMap { $0 }.max()
        reconnectDisplayAfter = page.messages.last?.position ?? after
        reconnectDisplayFailure = nil
        if page.nextAfter != nil { return [] }
        reconnectDisplayRequest = nil
        reconnectDisplayAfter = nil
      }
      switch current {
      case .failure(let failure): reconnectDisplayFailure = failure
      case .success(nil): break
      case .success(.some(let turn)):
        guard turn.isValid, merge([turn.input] + (turn.reply.receipt.map { [$0] } ?? [])) else {
          reconnectDisplayFailure = .invalidResponse
          return []
        }
        // This is a display probe. It never owns a new SSE reader, draft checkpoint
        // or response generation, and cannot displace a newer accepted input.
        guard !isSending, draft.content?.pending == nil,
          messages.last(where: { $0.role == .user })?.deliveryId == turn.input.deliveryId
        else { return [] }
        if case .observing(let observer, let input, _) = reply, input == turn.input.deliveryId {
          return receiveReply(observer, turn.reply)
        }
        if case .recovering = reply { return [] }
        if case .completed(let receipt) = reply,
          receipt.inputDeliveryId == turn.input.deliveryId
        {
          return []
        }
        if case .observationFailed(let input, let latest, _) = reply,
          input == turn.input.deliveryId, let latest,
          latest.responseId != turn.reply.responseId || latest.sequence > turn.reply.sequence
        {
          return []
        }
        if let failure = turn.reply.error {
          reply = .providerFailed(
            inputDeliveryId: turn.input.deliveryId, text: turn.reply.text, failure,
            languageSpans: turn.reply.languageSpans)
        } else if let receipt = turn.reply.receipt {
          reply = .completed(receipt)
        } else {
          reply = .observationFailed(
            inputDeliveryId: turn.input.deliveryId, latest: turn.reply, .unavailable)
        }
      }
      return []
    case .refreshCurrent:
      guard isActive, !isSending, replyRetryRequest == nil, currentRequest == nil else { return [] }
      let request = request()
      currentRequest = request
      return [.current(request)]
    case .currentLoaded(let request, let result):
      guard isActive, currentRequest == request else { return [] }
      currentRequest = nil
      switch result {
      case .failure(let error):
        currentFailure = error
        return []
      case .success(nil):
        currentFailure = nil
        return []
      case .success(.some(let turn)):
        guard turn.isValid, merge([turn.input]) else {
          currentFailure = .invalidResponse
          return []
        }
        currentFailure = nil
        let reconciliation = draft.content.flatMap { reconcilePending($0) } ?? []
        guard case .available(.editable, _) = draft, !isSending,
          messages.last(where: { $0.role == .user })?.deliveryId == turn.input.deliveryId
        else { return reconciliation }
        if case .observing(let existing, let input, _) = reply,
          input == turn.input.deliveryId
        {
          return reconciliation + receiveReply(existing, turn.reply)
        }
        let observation = self.request()
        reply = .observing(observation, inputDeliveryId: turn.input.deliveryId, latest: nil)
        let terminalCommands = receiveReply(observation, turn.reply)
        return reconciliation + [.cancelReply] + terminalCommands
          + (turn.reply.isTerminal ? [] : [.observeReply(observation, turn.input.deliveryId)])
      }
    case .retryReply:
      guard canRetryReply, case .providerFailed(let input, _, _, _) = reply else { return [] }
      platformCancellations[input] = nil
      currentRequest = nil
      let request = request()
      replyRetryRequest = request
      reply = .observing(request, inputDeliveryId: input, latest: nil)
      return [.cancelCurrent, .cancelReply, .retryReply(request, input)]
    case .retryLoaded(let request, let result):
      guard isActive, case .observing(let expected, let input, _) = reply,
        expected == request
      else { return [] }
      replyRetryRequest = nil
      switch result {
      case .failure(let error):
        reply = .observationFailed(inputDeliveryId: input, latest: nil, error)
        return []
      case .success(let snapshot):
        let commands = receiveReply(request, snapshot)
        return commands
          + (snapshot.isTerminal || replyObservationFailure != nil
            ? [] : [.observeReply(request, input)])
      }
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
      // Invalidate queued old snapshots immediately. Keep its transport attached
      // until POST decides interruption, so disconnect cannot race acceptance.
      switch reply {
      case .observing(_, let input, _), .recovering(_, let input, _, _): interruptedInput = input
      default: break
      }
      currentRequest = nil
      reconnectDisplayRequest = nil
      reconnectDisplayAfter = nil
      replyRetryRequest = nil
      reply = .idle
      delivery = .waitingCheckpoint(pending)
      if content.pending != nil, persistence == .clean {
        return [.inputIntent(pending.deliveryId)] + beginSend(pending)
      }
      return [.inputIntent(pending.deliveryId)]
        + checkpoint(.awaitingReceipt(pending), purpose: .pending)
    case .loadHistory(let refresh):
      guard isActive else { return [] }
      if isLoadingHistory {
        historyRefreshPending = historyRefreshPending || refresh
        return []
      }
      guard refresh || !hasLoadedHistory || hasMoreHistory else {
        return []
      }
      let request = request()
      let older = !refresh || !hasLoadedHistory
      let cursor = older ? nextBefore : historyCursor
      history = .loading(request, after: cursor, older: older)
      var commands: [ConversationCommand] = [.history(request, cursor, older: older)]
      if refresh, case .observationFailed(let input, _, _) = reply {
        let observation = self.request()
        // The first full snapshot of a fresh observer is authoritative for
        // this accepted input, including reconstructed sequence zero after restart.
        reply = .observing(observation, inputDeliveryId: input, latest: nil)
        commands.append(.observeReply(observation, input))
      }
      return commands
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
        guard receipt.isValid, receipt.role == .user, receipt.deliveryId == pending.deliveryId,
          receipt.text == pending.text,
          merge([receipt])
        else {
          delivery = .uncertain(pending, .invalidResponse)
          return []
        }
        delivery = .idle(nil)
        return checkpoint(.editable(text: ""), purpose: .confirmation)
          + followAcceptedInput(pending.deliveryId)
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
      guard isActive, case .loading(let expected, let after, let older) = history,
        expected == request
      else {
        return []
      }
      var commands = finishHistory(result, after: after, older: older)
      if !isLoadingHistory, historyRefreshPending {
        historyRefreshPending = false
        commands += transition(.loadHistory(refresh: true))
      }
      return commands
    case .replyReceived(let request, let snapshot):
      return receiveReply(request, snapshot)
    case .interruptedReplyRecovered(let request, let result):
      guard isActive, let input = interruptionRecoveries.removeValue(forKey: request) else {
        return []
      }
      switch result {
      case .success(let snapshot):
        guard snapshot.isValid, snapshot.inputDeliveryId == input, snapshot.isTerminal else {
          interruptedReceiptFailure = .invalidResponse
          return []
        }
        // A pre-delivery provider failure has no durable assistant receipt.
        if snapshot.state == .failed && snapshot.receipt == nil { return [] }
        guard let receipt = snapshot.receipt, merge([receipt]) else {
          interruptedReceiptFailure = .invalidResponse
          return []
        }
        interruptedReceiptFailure = nil
      case .failure(let error): interruptedReceiptFailure = error
      }
      return []
    case .observationRecovered(let request, let result):
      guard isActive, case .recovering(let expected, let input, let latest, _) = reply,
        expected == request
      else { return [] }
      switch result {
      case .failure(let error):
        if error == .unavailable { return recoverObservation(input, latest) }
        reply = .observationFailed(inputDeliveryId: input, latest: latest, error)
        return []
      case .success(let snapshot):
        // A full read is authoritative across backend restarts; never generate here.
        reply = .observing(request, inputDeliveryId: input, latest: nil)
        let commands = receiveReply(request, snapshot)
        return commands
          + (snapshot.isTerminal || replyObservationFailure != nil
            ? [] : [.observeReply(request, input)])
      }
    case .replyEnded(let request, let error):
      guard isActive, case .observing(let expected, let input, let latest) = reply,
        expected == request
      else { return [] }
      if error == nil || error == .unavailable { return recoverObservation(input, latest) }
      reply = .observationFailed(inputDeliveryId: input, latest: latest, error ?? .unavailable)
      return []
    case .shutdown:
      guard isActive else { return [] }
      // A changed generation invalidates network results. Draft completions
      // remain matched to their checkpoint until the serialized writer drains.
      if case .active(let generation) = connection {
        connection = .stopping(generation: generation + 1)
      }
      currentRequest = nil
      replyRetryRequest = nil
      history = .idle
      if case .recovering(_, let input, let latest, _) = reply {
        reply = .observationFailed(inputDeliveryId: input, latest: latest, .unavailable)
      }
      if case .observing(_, let input, let latest) = reply {
        reply = .observationFailed(inputDeliveryId: input, latest: latest, .unavailable)
      }
      if let pending = draft.content?.pending {
        delivery = .uncertain(pending, .unavailable)
      } else {
        delivery = .idle(nil)
      }
      if case .loading = draft { draft = .unloaded }
      interruptionRecoveries.removeAll()
      platformCancellations = [:]
      return [
        .cancelCurrent, .cancelSend, .cancelHistory, .cancelReply, .cancelInterruptionRecoveries,
        .cancelReconnectDisplay, .cancelPlatformInterruptions,
      ]
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
    return [.cancelCurrent, .send(request, pending)]
  }

  private mutating func finishHistory(
    _ result: Result<HistoryPage, ConversationFailure>, after: Int?, older: Bool
  ) -> [ConversationCommand] {
    switch result {
    case .failure(let error):
      history = .failed(error)
      return []
    case .success(let page):
      guard
        page.messages.count
          <= (older ? OlderHistoryPage.maximumMessages : HistoryPage.maximumMessages),
        page.messages.allSatisfy(\.isValid),
        zip(page.messages, page.messages.dropFirst()).allSatisfy({ $0.position < $1.position }),
        (older
          ? page.messages.last.map({ message in after.map { message.position < $0 } ?? true })
          : page.messages.first.map({ $0.position > (after ?? -1) })) ?? true,
        page.nextAfter == nil
          || page.nextAfter
            == (older ? page.messages.first?.position : page.messages.last?.position)
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
      if older {
        if !hasLoadedHistory { historyCursor = page.messages.last?.position }
        nextBefore = page.nextAfter
        hasMoreHistory = nextBefore != nil
      } else {
        historyCursor = [historyCursor, page.messages.last?.position, after].compactMap { $0 }.max()
      }
      hasLoadedHistory = true
      var replyCommands: [ConversationCommand] = []
      if !older, let cursor = page.nextAfter {
        let next = request()
        history = .loading(next, after: cursor, older: false)
        replyCommands.append(.history(next, cursor, older: false))
      }
      if case .observing(_, let input, let latest) = reply,
        let completed = page.messages.first(where: {
          $0.role == .assistant && $0.inputDeliveryId == input
        }),
        latest == nil || completed.responseId == latest?.responseId
      {
        reply = .completed(completed)
        replyCommands.append(.cancelReply)
      }
      if let accepted {
        delivery = .idle(nil)
        return replyCommands + [.cancelSend]
          + checkpoint(.editable(text: ""), purpose: .confirmation)
          + followAcceptedInput(accepted.deliveryId)
      }
      return replyCommands
    }
  }

  private mutating func receiveReply(_ request: Request, _ snapshot: ReplySnapshot)
    -> [ConversationCommand]
  {
    guard isActive, case .observing(let expected, let input, let latest) = reply,
      expected == request
    else { return [] }
    guard snapshot.isValid, snapshot.inputDeliveryId == input,
      latest == nil || latest?.responseId == snapshot.responseId
    else { return failObservation(input, latest) }
    if let latest {
      if snapshot.sequence < latest.sequence { return [] }
      if snapshot.sequence == latest.sequence {
        return snapshot == latest ? [] : failObservation(input, latest)
      }
      guard snapshot.text.hasPrefix(latest.text) else { return failObservation(input, latest) }
    }
    observationRecoveryAttempt = 0
    switch snapshot.state {
    case .waiting, .streaming, .delivering:
      reply = .observing(request, inputDeliveryId: input, latest: snapshot)
    case .failed:
      guard let error = snapshot.error else { return failObservation(input, latest) }
      if let receipt = snapshot.receipt, !merge([receipt]) { return failObservation(input, latest) }
      reply = .providerFailed(
        inputDeliveryId: input, text: snapshot.text, error,
        languageSpans: snapshot.languageSpans)
      return [.cancelReply]
    case .completed, .interrupted:
      guard let receipt = snapshot.receipt, merge([receipt]) else {
        return failObservation(input, latest)
      }
      reply = .completed(receipt)
      return [.cancelReply]
    }
    return []
  }

  private mutating func recoverObservation(_ input: UUID, _ latest: ReplySnapshot?)
    -> [ConversationCommand]
  {
    observationRecoveryAttempt = min(observationRecoveryAttempt + 1, 5)
    let recovery = request()
    reply = .recovering(
      recovery, inputDeliveryId: input, latest: latest,
      attempt: observationRecoveryAttempt)
    return [.cancelReply, .recoverObservation(recovery, input, observationRecoveryAttempt)]
  }

  private mutating func failObservation(_ input: UUID, _ latest: ReplySnapshot?)
    -> [ConversationCommand]
  {
    reply = .observationFailed(inputDeliveryId: input, latest: latest, .invalidResponse)
    return [.cancelReply]
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
      + followAcceptedInput(pending.deliveryId)
  }

  /// POST and recovered history acknowledgements share the same observer handoff.
  /// Already durable assistant evidence needs no subscription or regeneration.
  private mutating func followAcceptedInput(_ input: UUID) -> [ConversationCommand] {
    guard isActive,
      messages.last(where: { $0.role == .user })?.deliveryId == input
    else { return [] }
    var recoveryCommands: [ConversationCommand] = []
    if let interruptedInput {
      let recovery = request()
      interruptionRecoveries[recovery] = interruptedInput
      recoveryCommands = [.recoverInterruptedReply(recovery, interruptedInput)]
      self.interruptedInput = nil
    }
    if let completed = messages.first(where: {
      $0.role == .assistant && $0.inputDeliveryId == input
    }) {
      reply = .completed(completed)
      return [.cancelReply] + recoveryCommands
    }
    if case .observing(_, let current, _) = reply, current == input { return recoveryCommands }
    let observation = request()
    reply = .observing(observation, inputDeliveryId: input, latest: nil)
    return [.cancelReply, .observeReply(observation, input)] + recoveryCommands
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

extension ConversationState {
  /// A platform cut cancels only the input/response captured by that intent.
  /// Missing response identity is resolved only for those bounded inputs; a
  /// later retry clears the fence before it can capture a new generation.
  mutating func platformInterruptionTransition(_ event: ConversationEvent) -> [ConversationCommand]
  {
    guard isActive else { return [] }
    switch event {
    case .platformInterruptionFailed(let request, let input):
      guard platformCancellations[input]?.request == request else { return [] }
      interruptedReceiptFailure = .unavailable
      return []
    case .platformInterrupt(let handedInputs):
      var inputs = Array(Set(handedInputs.prefix(2)))
      var current: ReplySnapshot?
      switch reply {
      case .observing(_, let input, let latest), .recovering(_, let input, let latest, _),
        .observationFailed(let input, let latest, _):
        current = latest
        if !inputs.contains(input) { inputs.append(input) }
      default: break
      }
      // A new platform intent supersedes obsolete displayed targets; the
      // handed-final set itself is supplied from the bounded Voice owner.
      let obsolete = platformCancellations.filter { !inputs.contains($0.key) }.values.map(\.request)
      platformCancellations = platformCancellations.filter { inputs.contains($0.key) }
      var commands: [ConversationCommand] =
        obsolete.isEmpty ? [] : [.cancelPlatformTargets(obsolete)]
      for input in inputs where platformCancellations[input] == nil {
        guard platformCancellations.count < 3 else { break }
        let request = request()
        let snapshot = current?.inputDeliveryId == input ? current : nil
        if snapshot?.isTerminal == true { continue }
        platformCancellations[input] = PlatformCancellation(
          request: request, responseId: snapshot?.responseId)
        if let snapshot {
          commands.append(.interruptPlatformTarget(request, input, snapshot.responseId))
        } else if messages.contains(where: { $0.deliveryId == input && $0.role == .user }) {
          commands.append(.findPlatformTarget(request, input))
        }
      }
      return commands
    case .platformTargetLoaded(let request, let input, let snapshot):
      guard let target = platformCancellations[input], target.request == request,
        let snapshot, snapshot.isValid, snapshot.inputDeliveryId == input,
        target.responseId == nil || target.responseId == snapshot.responseId
      else { return [] }
      if snapshot.isTerminal {
        platformCancellations[input] = nil
        return []
      }
      platformCancellations[input]?.responseId = snapshot.responseId
      return [.interruptPlatformTarget(request, input, snapshot.responseId)]
    case .platformInterrupted(let request, let input, let snapshot):
      guard let target = platformCancellations[input], target.request == request else { return [] }
      guard let snapshot else {
        platformCancellations[input] = nil
        return []
      }
      guard snapshot.isValid, snapshot.inputDeliveryId == input,
        snapshot.responseId == target.responseId
      else { return [] }
      platformCancellations[input] = nil
      if let receipt = snapshot.receipt { _ = merge([receipt]) }
      return []
    default: return []
    }
  }
}
