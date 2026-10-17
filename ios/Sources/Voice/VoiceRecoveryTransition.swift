import Foundation

#if canImport(Conversation)
  import Conversation
#endif

extension VoiceState {
  internal var pendingAssociations: [VoiceAdmissionAssociation] {
    associations.values.sorted { $0.deliveryId.uuidString < $1.deliveryId.uuidString }
  }
  internal func admissionText(_ id: UUID) -> String? {
    switch admissions[id] { case .saving(_, let text), .checking(_, let text): text; default: nil }
  }
}
internal func markVoiceChecking(_ state: VoiceState) -> VoiceState {
  let admissions = state.admissions.mapValues { value in
    if case .saving(let id, let text) = value { return VoiceState.Admission.checking(deliveryId: id, text: text) }
    return value
  }
  return state.replacing(recovery: state.recovery.replacing(admissions: admissions))
}
private func trimVoiceAdmissions(_ state: VoiceState) -> VoiceState {
  let settled = state.utterances.filter { state.associations[$0] == nil && state.stagedFinals[$0] == nil }
  let removed = Set(settled.dropLast(1))
  return state.replacing(recovery: state.recovery.replacing(
    admissionLanguageSpans: state.admissionLanguageSpans.filter { !removed.contains($0.key) },
    admissions: state.admissions.filter { !removed.contains($0.key) }, utterances: state.utterances.filter { !removed.contains($0) }))
}
internal func stageVoiceFinal(_ state: VoiceState, association: VoiceAdmissionAssociation, text: String,
  spans: [LanguageSpan], proposedId: UUID) -> VoiceTransition {
  if let accepted = state.recentAcceptedAdmissions.first(where: { $0.association.identity == association.identity }) {
    return accepted.receipt.text == text && accepted.receipt.languageSpans == spans
      && accepted.receipt.detectedLanguage == association.detectedLanguage ? unchangedVoice(state)
      : failVoiceTransport(state, .invalidResponse, proposedId: proposedId)
  }
  if let known = state.associations[association.deliveryId] {
    guard known == association,
      state.stagedFinals[association.deliveryId] == nil || state.stagedFinals[association.deliveryId] == text,
      state.admissionLanguageSpans[association.deliveryId] == nil || state.admissionLanguageSpans[association.deliveryId] == spans
    else { return failVoiceTransport(state, .invalidResponse, proposedId: proposedId) }
    return unchangedVoice(state)
  }
  switch state.admissions[association.deliveryId] { case .saved, .failed: return unchangedVoice(state); default: break }
  guard state.associations.count < 2 else {
    return failVoiceTransport(state, .backend(code: "AdmissionCapacity", message: "Speech admission tracking is full"), proposedId: proposedId)
  }
  let trimmed = trimVoiceAdmissions(state)
  let recovery = trimmed.recovery.replacing(
    associations: trimmed.associations.merging([association.deliveryId: association]) { _, new in new },
    stagedFinals: trimmed.stagedFinals.merging([association.deliveryId: text]) { _, new in new },
    checkpointRevision: trimmed.checkpointRevision + 1,
    admissionLanguageSpans: trimmed.admissionLanguageSpans.merging([association.deliveryId: spans]) { _, new in new })
  let staged = trimmed.replacing(capture: trimmed.captureModel.replacing(unrecognizedUtterance: .some(nil)), recovery: recovery,
    execution: state.associations.isEmpty ? state.execution.replacing(resolutionStep: 0) : state.execution)
  if staged.associations.count == 2, staged.wantsListening, staged.sessionId != nil,
    staged.capture == .listening, !staged.muteInFlight {
    return requestVoiceMute(staged.replacing(capture: staged.captureModel.replacing(capture: .checkingPreviousSpeech)), true)
  }
  return unchangedVoice(staged)
}
internal func acceptVoiceAdmission(_ state: VoiceState, association: VoiceAdmissionAssociation,
  receipt: ConversationMessage, expectedText: String?, proposedId: UUID) -> VoiceTransition {
  guard receipt.isValid, receipt.role == .user, receipt.deliveryId == association.deliveryId,
    expectedText == nil || expectedText?.isEmpty == true || expectedText == receipt.text else { return unchangedVoice(state) }
  if let known = state.associations[association.deliveryId] {
    guard known.identity == association.identity, known.detectedLanguage == receipt.detectedLanguage else { return unchangedVoice(state) }
  }
  let exact = state.associations[association.deliveryId] ?? association
  if let accepted = state.recentAcceptedAdmissions.first(where: { $0.association.identity == exact.identity }) {
    return accepted.receipt == receipt ? unchangedVoice(state) : failVoiceTransport(state, .invalidResponse, proposedId: proposedId)
  }
  if let spans = state.admissionLanguageSpans[association.deliveryId], spans != receipt.languageSpans { return unchangedVoice(state) }
  if state.admissions[association.deliveryId] == .saved(receipt) { return unchangedVoice(state) }
  let id = association.deliveryId
  let recovery = state.recovery.replacing(
    recentAcceptedAdmissions: Array((state.recentAcceptedAdmissions + [VoiceAcceptedAdmission(association: exact, receipt: receipt)]).suffix(2)),
    associations: state.associations.filter { $0.key != id }, stagedFinals: state.stagedFinals.filter { $0.key != id },
    checkpointRevision: state.checkpointRevision + 1,
    admissionLanguageSpans: state.admissionLanguageSpans.merging([id: receipt.languageSpans]) { _, new in new },
    admissions: state.admissions.merging([id: .saved(receipt)]) { _, new in new },
    utterances: state.utterances.contains(id) ? state.utterances : state.utterances + [id])
  let saved = trimVoiceAdmissions(state.replacing(recovery: recovery))
  let projected = composeVoiceOutput(VoiceTransition(state: saved, commands: [.accepted(receipt)]), .inputAccepted(id))
  return finishVoiceResolutionEpisode(continueVoice(projected, restoreVoiceCaptureAfterAdmission))
}
internal func restoreVoiceCaptureAfterAdmission(_ state: VoiceState) -> VoiceTransition {
  guard state.associations.isEmpty, state.wantsListening, state.capture == .checkingPreviousSpeech,
    state.sessionId != nil, !state.muteInFlight else { return unchangedVoice(state) }
  return state.wantsMuted ? unchangedVoice(state.replacing(capture: state.captureModel.replacing(capture: .muted)))
    : requestVoiceMute(state, false)
}
internal func progressVoiceCheckpoint(_ state: VoiceState) -> VoiceTransition {
  guard state.checkpointLoaded,
    state.checkpointRevision > state.recovery.checkpointSavedRevision,
    state.recovery.checkpointFailureRevision != state.checkpointRevision,
    !hasVoiceOperation(state, where: { if case .checkpoint = $0 { true } else { false } }) else { return unchangedVoice(state) }
  return reserveVoice(state, .checkpoint(revision: state.checkpointRevision, associations: state.pendingAssociations))
}
internal func checkpointVoiceCompleted(_ state: VoiceState, revision: Int, result: Result<Void, VoiceFailure>, proposedId: UUID) -> VoiceTransition {
  switch result {
  case .failure:
    let failed = state.replacing(recovery: state.recovery.replacing(checkpointFailureRevision: .some(revision),
      admissionFailure: .some(.checkpointUnavailable)))
    let stopped = failVoiceTransport(failed, .checkpointUnavailable, proposedId: proposedId)
    guard !state.isRetired, !state.associations.isEmpty,
      !hasVoiceOperation(stopped.state, where: { if case .resolve = $0 { true } else { false } }) else { return stopped }
    return continueVoice(stopped) { reserveVoice($0, .resolve($0.pendingAssociations)) }
  case .success:
    let acknowledged = state.replacing(recovery: state.recovery.replacing(
      checkpointSavedRevision: max(revision, state.recovery.checkpointSavedRevision)))
    guard revision == state.checkpointRevision else { return unchangedVoice(acknowledged) }
    let admissions = state.stagedFinals.reduce(state.admissions) { values, entry in
      values.merging([entry.key: state.wantsListening ? .saving(deliveryId: entry.key, text: entry.value)
        : .checking(deliveryId: entry.key, text: entry.value)]) { _, new in new }
    }
    let utterances = state.stagedFinals.keys.sorted { $0.uuidString < $1.uuidString }.reduce(state.utterances) {
      $0.contains($1) ? $0 : $0 + [$1]
    }
    return unchangedVoice(acknowledged.replacing(recovery: acknowledged.recovery.replacing(stagedFinals: [:],
      checkpointFailureRevision: .some(nil), admissionFailure: .some(nil), admissions: admissions, utterances: utterances)))
  }
}
internal func restoreVoiceCheckpoint(_ state: VoiceState, _ result: Result<[VoiceAdmissionAssociation], VoiceFailure>, proposedId: UUID) -> VoiceTransition {
  switch result {
  case .failure:
    return failVoiceTransport(state, .checkpointUnavailable, proposedId: proposedId)
  case .success(let values):
    guard values.count <= 2, values.allSatisfy(\.isValid), Set(values.map(\.deliveryId)).count == values.count else {
      return failVoiceTransport(state, .checkpointUnavailable, proposedId: proposedId)
    }
    let associations = values.reduce(state.associations) { result, value in result.merging([value.deliveryId: value]) { _, new in new } }
    let admissions = values.reduce(state.admissions) { result, value in result[value.deliveryId] == nil
      ? result.merging([value.deliveryId: .checking(deliveryId: value.deliveryId, text: "")]) { _, new in new } : result }
    let utterances = values.reduce(state.utterances) { $0.contains($1.deliveryId) ? $0 : $0 + [$1.deliveryId] }
    return unchangedVoice(state.replacing(capture: state.bootstrapKnown ? state.captureModel
      : state.captureModel.replacing(startMuted: state.wantsMuted || !associations.isEmpty),
      recovery: state.recovery.replacing(associations: associations, checkpointLoaded: true, admissions: admissions, utterances: utterances)))
  }
}
