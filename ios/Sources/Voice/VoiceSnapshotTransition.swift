import Foundation

/// Handed admission may still be observed after capture ends. Shutdown retires
/// this observer; it never retires the independent durable checkpoint.
internal func progressVoiceObservation(_ state: VoiceState) -> VoiceTransition {
  guard !state.isRetired, state.admissionFailure != .capture, let origin = state.origin,
    [.listening, .muted, .checkingPreviousSpeech].contains(state.capture)
      || (!state.wantsListening && state.hasPendingAdmission),
    !state.execution.operations.values.contains(where: { operation in
      guard !operation.cancelling else { return false }
      switch operation.kind {
      case .snapshot(let observed, _), .sleep(_, .observation(let observed)):
        return observed == origin
      default: return false
      }
    })
  else { return unchangedVoice(state) }
  return reserveVoice(state, .snapshot(origin, after: state.sequence))
}

/// Canonical pending admissions and ordered wire observations enter the same
/// feature transition. A page cannot borrow a newer session's authorization.
internal func voiceSnapshotObserved(
  _ state: VoiceState, requestOrigin: VoiceOrigin, page: VoiceSnapshot, proposedId: UUID
) -> VoiceTransition {
  guard !state.isRetired, state.origin == requestOrigin,
    page.sessionId == requestOrigin.sessionId,
    page.backendIncarnationId == requestOrigin.backendIncarnationId,
    page.sequence >= state.snapshotSequence
  else { return unchangedVoice(state) }
  let advanced = state.replacing(capture: state.captureModel.replacing(
    snapshotSequence: page.sequence, sequence: max(state.sequence, page.firstSequence - 1)))
  let pending = observeVoicePending(advanced, page: page, proposedId: proposedId)
  let canonical = continueVoice(pending) { current in
    page.status == "ended" && current.wantsListening
      ? failVoiceTransport(current, .connection, proposedId: proposedId) : unchangedVoice(current)
  }
  let events = page.events.reduce(canonical) { step, event in
    continueVoice(step) { current in
      voiceWireObserved(current, origin: requestOrigin, event: event, proposedId: proposedId)
    }
  }
  return continueVoice(events) { current in
    guard let output = page.output else { return unchangedVoice(current) }
    return observeVoiceOutput(current, origin: requestOrigin, sequence: page.sequence, output: output)
  }
}

private func observeVoicePending(
  _ state: VoiceState, page: VoiceSnapshot, proposedId: UUID
) -> VoiceTransition {
  page.pending.reduce(unchangedVoice(state)) { step, pending in
    continueVoice(step) { current in
      guard pending.isValid, pending.backendIncarnationId == page.backendIncarnationId else {
        return unchangedVoice(current)
      }
      let association = VoiceAdmissionAssociation(
        backendIncarnationId: pending.backendIncarnationId, sessionId: page.sessionId,
        deliveryId: pending.deliveryId, detectedLanguage: pending.detectedLanguage)
      if let receipt = pending.receipt {
        return acceptVoiceAdmission(current, association: association, receipt: receipt,
          expectedText: pending.text, proposedId: proposedId)
      }
      return stageVoiceFinal(current, association: association, text: pending.text,
        spans: pending.languageSpans, proposedId: proposedId)
    }
  }
}

private func voiceWireObserved(
  _ state: VoiceState, origin: VoiceOrigin, event: VoiceWireEvent, proposedId: UUID
) -> VoiceTransition {
  guard !state.isRetired, state.origin == origin, event.sessionId == origin.sessionId,
    event.sequence > state.sequence, event.isValid
  else { return unchangedVoice(state) }
  let advanced = state.replacing(capture: state.captureModel.replacing(sequence: event.sequence))
  switch event.kind {
  case "Interim":
    guard state.capture == .listening else { return unchangedVoice(advanced) }
    let notice: VoiceState.InputNotice??
    if case .captureDiscontinuity(let missed) = advanced.inputNotice, missed != event.utteranceId {
      notice = .some(nil)
    } else { notice = nil }
    return unchangedVoice(advanced.replacing(capture: advanced.captureModel.replacing(
      tentative: event.text ?? "", tentativeUtterance: .some(event.utteranceId), inputNotice: notice)))
  case "Final":
    guard let delivery = event.deliveryId, let text = event.text,
      event.backendIncarnationId == origin.backendIncarnationId else { return unchangedVoice(advanced) }
    let cleared = clearVoiceTentative(advanced, utterance: event.utteranceId)
    return stageVoiceFinal(cleared.replacing(capture: cleared.captureModel.replacing(
      inputNotice: .some(nil))), association: VoiceAdmissionAssociation(
        backendIncarnationId: origin.backendIncarnationId, sessionId: origin.sessionId,
        deliveryId: delivery, detectedLanguage: event.detectedLanguage), text: text,
      spans: event.languageSpans ?? [], proposedId: proposedId)
  case "Discarded": return unchangedVoice(clearVoiceTentative(advanced, utterance: event.utteranceId))
  case "Accepted":
    guard let receipt = event.receipt, let association = advanced.associations[receipt.deliveryId]
    else { return unchangedVoice(advanced) }
    return acceptVoiceAdmission(advanced, association: association, receipt: receipt,
      expectedText: advanced.stagedFinals[receipt.deliveryId] ?? advanced.admissionText(receipt.deliveryId),
      proposedId: proposedId)
  case "Error": return voiceWireFailure(advanced, event: event, proposedId: proposedId)
  case "Ended":
    let cleared = advanced.replacing(capture: advanced.captureModel.replacing(
      muteInFlight: false, tentative: "", tentativeUtterance: .some(nil)))
    return cleared.wantsListening ? failVoiceTransport(cleared, .connection, proposedId: proposedId)
      : unchangedVoice(cleared)
  default:
    guard let output = event.output else { return unchangedVoice(advanced) }
    return observeVoiceOutput(advanced, origin: origin, sequence: event.sequence, output: output)
  }
}

private func clearVoiceTentative(_ state: VoiceState, utterance: UUID?) -> VoiceState {
  guard state.tentativeUtterance == utterance else { return state }
  return state.replacing(capture: state.captureModel.replacing(
    tentative: "", tentativeUtterance: .some(nil)))
}

private func voiceWireFailure(
  _ state: VoiceState, event: VoiceWireEvent, proposedId: UUID
) -> VoiceTransition {
  let step = decideVoiceWireFailure(state, event: event, proposedId: proposedId)
  return VoiceTransition(state: step.state, commands: voiceTrace(state, .wireError,
    failure: .backend(code: event.code ?? "", message: "")) + step.commands)
}

private func decideVoiceWireFailure(
  _ state: VoiceState, event: VoiceWireEvent, proposedId: UUID
) -> VoiceTransition {
  // A discontinuity abandons only unfinished microphone input. It cannot
  // authorize admission resolution, retire the session or interrupt playout.
  if event.code == "CaptureDiscontinuity" {
    guard [.listening, .muted, .checkingPreviousSpeech].contains(state.capture) else { return unchangedVoice(state) }
    guard let utterance = event.utteranceId else {
      // No abandoned speech: repair only stale interim input, without inventing
      // a repeat request or overwriting an existing notice for another turn.
      return unchangedVoice(state.replacing(capture: state.captureModel.replacing(
        tentative: "", tentativeUtterance: .some(nil))))
    }
    guard state.associations[utterance] == nil,
      !state.recentAcceptedAdmissions.contains(where: { $0.association.deliveryId == utterance }),
      state.admissions[utterance] == nil,
      state.tentativeUtterance == nil || state.tentativeUtterance == utterance
    else { return unchangedVoice(state) }
    let cleared = clearVoiceTentative(state, utterance: utterance)
    return unchangedVoice(cleared.replacing(capture: cleared.captureModel.replacing(
      inputNotice: .some(.captureDiscontinuity(utterance)))))
  }
  if let utterance = event.utteranceId, let association = state.associations[utterance] {
    let checking: VoiceState
    if let text = state.admissionText(utterance) {
      checking = state.replacing(recovery: state.recovery.replacing(
        admissions: state.admissions.merging([
          utterance: .checking(deliveryId: association.deliveryId, text: text)
        ]) { _, new in new }))
    } else { checking = state }
    guard !hasVoiceOperation(checking, where: { if case .resolve = $0 { true } else { false } })
    else { return unchangedVoice(checking) }
    return reserveVoice(checking, .resolve(checking.pendingAssociations))
  }
  guard [.listening, .muted].contains(state.capture) else { return unchangedVoice(state) }
  if let utterance = event.utteranceId,
    ["RecognitionFailed", "InvalidRecognition"].contains(event.code ?? "") {
    let cleared = clearVoiceTentative(state, utterance: utterance)
    return unchangedVoice(cleared.replacing(capture: cleared.captureModel.replacing(
      inputNotice: .some(.unrecognized(utterance)))))
  }
  return failVoiceTransport(state,
    .backend(code: event.code ?? "", message: event.message ?? ""), proposedId: proposedId)
}

private func observeVoiceOutput(
  _ state: VoiceState, origin: VoiceOrigin, sequence: Int, output: VoiceOutput
) -> VoiceTransition {
  guard state.origin == origin, [.listening, .muted].contains(state.capture),
    output.isValid(sessionId: origin.sessionId) else { return unchangedVoice(state) }
  return composeVoiceOutput(unchangedVoice(state), .observed(sequence: sequence, output))
}

/// Sealing establishes producer closure only; an absent producer never supplies
/// a NotAccepted verdict for the independently retained admission checkpoint.
internal func voiceSealed(
  _ state: VoiceState, origin: VoiceOrigin, result: VoiceSealResult, proposedId: UUID
) -> VoiceTransition {
  guard state.drainingOrigin == origin else { return unchangedVoice(state) }
  switch result {
  case .producerUnavailable(let session, let incarnation):
    guard session == origin.sessionId, incarnation == origin.backendIncarnationId else {
      return unchangedVoice(state)
    }
    return unchangedVoice(state.replacing(capture: state.captureModel.replacing(drainingOrigin: .some(nil))))
  case .ended(let page):
    guard page.sessionId == origin.sessionId, page.backendIncarnationId == origin.backendIncarnationId
    else { return unchangedVoice(state) }
    guard page.status == "ended" else {
      let paused = state.replacing(capture: state.captureModel.replacing(capture: .paused, resumeProbe: false))
      return cancelVoice(paused) { _, operation in
        switch operation.kind { case .permission, .bootstrap, .connect: true; default: false }
      }
    }
    let cleared = state.replacing(capture: state.captureModel.replacing(drainingOrigin: .some(nil)))
    let pending = observeVoicePending(cleared, page: page, proposedId: proposedId)
    let reconciled = pending.state.bootstrapKnown ? pending.state : pending.state.replacing(
      capture: pending.state.captureModel.replacing(startMuted: pending.state.wantsMuted || pending.state.hasPendingAdmission))
    let handed = Array(page.pending.filter {
      $0.isValid && $0.backendIncarnationId == origin.backendIncarnationId
    }.map(\.deliveryId).prefix(2))
    let step = VoiceTransition(state: reconciled, commands: pending.commands)
    guard !handed.isEmpty else { return step }
    let stopped = step.state.execution.localStop == nil
      ? continueVoice(step) { stopVoiceMedia($0, capture: false, output: true) } : step
    guard let barrier = stopped.state.execution.localStop else { return stopped }
    return VoiceTransition(state: stopped.state, commands: stopped.commands + [.interruptConversation(handed, after: barrier)])
  }
}
