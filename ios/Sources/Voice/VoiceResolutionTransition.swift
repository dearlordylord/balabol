import Foundation

internal func voiceResolutionRetryable(_ error: VoiceFailure) -> Bool {
  switch error {
  case .connection: true
  case .backend(let code, _): ["Unavailable", "StorageUnavailable", "VoiceBusy"].contains(code)
  default: false
  }
}
private func needsVoiceResolution(_ state: VoiceState) -> Bool {
  !state.wantsListening || [.hostUnavailable, .reconnecting, .checkingPreviousSpeech, .paused].contains(state.capture)
    || state.associations.values.contains { $0.sessionId != state.sessionId }
}
internal func progressVoiceResolution(_ state: VoiceState) -> VoiceTransition {
  let checkpointAllowsLookup = state.stagedFinals.isEmpty || state.recovery.checkpointFailureRevision == state.checkpointRevision
  let failureAllowsLookup = state.admissionFailure.map { $0 == .checkpointUnavailable || voiceResolutionRetryable($0) } ?? true
  guard !state.execution.shuttingDown, state.checkpointLoaded, !state.associations.isEmpty, checkpointAllowsLookup,
    needsVoiceResolution(state), failureAllowsLookup,
    !state.execution.operations.values.contains(where: { operation in
      guard !operation.cancelling else { return false }
      return switch operation.kind { case .resolve, .sleep(_, .resolution): true; default: false }
    }) else { return unchangedVoice(state) }
  return reserveVoice(state, .resolve(state.pendingAssociations))
}
private func retryVoiceResolution(_ state: VoiceState) -> VoiceTransition {
  guard !state.associations.isEmpty, !state.execution.shuttingDown else { return unchangedVoice(state) }
  let delays = [500, 1000, 2000, 4000, 8000]
  let step = min(state.execution.resolutionStep, delays.count - 1)
  return reserveVoice(state.replacing(execution: state.execution.replacing(resolutionStep: min(step + 1, delays.count - 1))),
    .sleep(milliseconds: delays[step], purpose: .resolution))
}
internal func voiceResolutionCompleted(_ state: VoiceState, requested: [VoiceAdmissionAssociation],
  result: Result<VoiceAdmissionResolution, VoiceFailure>, proposedId: UUID) -> VoiceTransition {
  switch result {
  case .failure(let failure):
    let failed = markVoiceChecking(state.replacing(recovery: state.recovery.replacing(admissionFailure: .some(failure))))
    return voiceResolutionRetryable(failure) ? retryVoiceResolution(failed) : unchangedVoice(failed)
  case .success(let response):
    guard response.isValid(for: requested) else { return retryVoiceResolution(state) }
    let resolved = response.admissions.reduce(unchangedVoice(state.replacing(recovery: state.recovery.replacing(admissionFailure: .some(nil))))) { step, value in
      continueVoice(step) { current in
        guard current.associations[value.deliveryId]?.identity == value.association.identity else { return unchangedVoice(current) }
        switch value.status {
        case .accepted:
          guard let receipt = value.receipt else { return unchangedVoice(current) }
          return acceptVoiceAdmission(current, association: value.association, receipt: receipt,
            expectedText: current.stagedFinals[value.deliveryId] ?? current.admissionText(value.deliveryId), proposedId: proposedId)
        case .notAccepted: return rejectVoiceAdmission(current, id: value.deliveryId)
        case .unknown: return unchangedVoice(markVoiceChecking(current))
        }
      }
    }
    return continueVoice(resolved, retryVoiceResolution)
  }
}
private func rejectVoiceAdmission(_ state: VoiceState, id: UUID) -> VoiceTransition {
  let text = state.stagedFinals[id] ?? state.admissionText(id) ?? ""
  let recovery = state.recovery.replacing(associations: state.associations.filter { $0.key != id },
    stagedFinals: state.stagedFinals.filter { $0.key != id }, checkpointRevision: state.checkpointRevision + 1,
    admissions: state.admissions.merging([id: .failed(text: text, .backend(code: "NotAccepted", message: "Please repeat the speech"))]) { _, new in new },
    utterances: state.utterances.contains(id) ? state.utterances : state.utterances + [id])
  return finishVoiceResolutionEpisode(restoreVoiceCaptureAfterAdmission(state.replacing(recovery: recovery)))
}
internal func finishVoiceResolutionEpisode(_ step: VoiceTransition) -> VoiceTransition {
  guard step.state.associations.isEmpty else { return step }
  return continueVoice(step) { state in
    cancelVoice(state.replacing(execution: state.execution.replacing(resolutionStep: 0))) { _, operation in
      switch operation.kind { case .resolve, .sleep(_, .resolution): true; default: false }
    }
  }
}
