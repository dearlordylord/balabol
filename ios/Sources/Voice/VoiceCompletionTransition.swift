import Foundation

internal func completeVoice(_ state: VoiceState, request: VoiceRequest, result: VoiceWorkResult, proposedId: UUID) -> VoiceTransition {
  guard let operation = state.execution.operations[request] else { return unchangedVoice(state) }
  let settled = removeVoiceOperation(state, request)
  let current = request.generation == state.generation && !operation.cancelling && !state.isRetired
  if case .cancelled = result {
    switch operation.kind {
    case .endBootstrap(let origin): return completeVoiceBootstrapRelease(settled, origin: origin, result: .failure(.connection))
    case .sleep(_, .bootstrapCleanup(let origin)): return retryVoiceBootstrapRelease(settled, origin: origin)
    default: return unchangedVoice(settled)
    }
  }
  switch (operation.kind, result) {
  case (.permission, .permission(let allowed)):
    return current ? voicePermissionCompleted(settled, allowed: allowed) : unchangedVoice(settled)
  case (.bootstrap(let id, let muted), .bootstrapped(let value)):
    return voiceBootstrapCompleted(settled, requestedId: id, muted: muted, result: value, current: current, proposedId: proposedId)
  case (.connect(let origin, let muted), .connected(let value)):
    return voiceConnectCompleted(settled, request: request, origin: origin, muted: muted, result: value, current: current, proposedId: proposedId)
  case (.localMute(let muted), .localMuted(let value)):
    return current ? voiceLocalMuteCompleted(settled, muted: muted, result: value, proposedId: proposedId) : unchangedVoice(settled)
  case (.remoteMute(_, let muted), .remoteMuted(let value)):
    return current ? voiceRemoteMuteCompleted(settled, muted: muted, result: value, proposedId: proposedId) : unchangedVoice(settled)
  case (.languages, .languages(let value)):
    return current ? voiceLanguagesCompleted(settled, value) : unchangedVoice(settled)
  case (.restoreCheckpoint, .restored(let value)):
    return state.isRetired || operation.cancelling ? unchangedVoice(settled) : restoreVoiceCheckpoint(settled, value, proposedId: proposedId)
  case (.checkpoint(let revision, _), .checkpoint(let value)):
    return checkpointVoiceCompleted(settled, revision: revision, result: value, proposedId: proposedId)
  case (.resolve(let associations), .resolved(let value)):
    return state.isRetired || operation.cancelling ? unchangedVoice(settled)
      : voiceResolutionCompleted(settled, requested: associations, result: value, proposedId: proposedId)
  case (.snapshot(let origin, _), .snapshot(let value)):
    return current ? voiceSnapshotCompleted(settled, origin: origin, result: value, proposedId: proposedId) : unchangedVoice(settled)
  case (.seal(let origin), .sealed(let value)):
    return voiceSealCompleted(settled, origin: origin, result: value, proposedId: proposedId)
  case (.prepareOutput(let manifest), .outputPrepared(let value)):
    return outputVoicePrepared(settled, request: request, manifest: manifest, result: value)
  case (.ready(let origin, let manifest), .ready(let value)):
    return current ? voiceReadyCompleted(settled, origin: origin, manifest: manifest, result: value, proposedId: proposedId) : unchangedVoice(settled)
  case (.interrupt, .interrupted): return unchangedVoice(settled)
  case (.stopMedia, .stopped): return unchangedVoice(settled)
  case (.disconnect, .disconnected):
    return request.generation == state.generation && state.capture == .ending ? unchangedVoice(settled.replacing(capture: settled.captureModel.replacing(capture: .ended))) : unchangedVoice(settled)
  case (.endBootstrap(let origin), .bootstrapEnded(let value)):
    return completeVoiceBootstrapRelease(settled, origin: origin, result: value)
  case (.sleep(_, let purpose), .elapsed): return voiceTimerCompleted(settled, request: request, purpose: purpose)
  case (.sleep(_, let purpose), .timerFailed):
    return voiceTimerFailed(settled, request: request, purpose: purpose, proposedId: proposedId)
  case (.observePlatform, .platformObserved), (.retirePlatformObservation, .platformRetired): return unchangedVoice(settled)
  default: return unchangedVoice(state) // An unrelated fact cannot acknowledge this operation.
  }
}
private func voiceTimerFailed(_ state: VoiceState, request: VoiceRequest, purpose: VoiceTimerPurpose,
  proposedId: UUID) -> VoiceTransition {
  if case .bootstrapCleanup(let origin) = purpose { return retryVoiceBootstrapRelease(state, origin: origin) }
  guard request.generation == state.generation, !state.isRetired else { return unchangedVoice(state) }
  // A spontaneous clock failure is availability failure, not elapsed time. Keep
  // provenance and require explicit recovery rather than silently respawning work.
  let failed = markVoiceChecking(state.replacing(recovery: state.recovery.replacing(admissionFailure: .some(.capture))))
  switch purpose {
  case .resolution: return unchangedVoice(failed)
  case .captureRetry, .observation: return failVoiceTransport(failed, .capture, proposedId: proposedId)
  case .bootstrapCleanup: return unchangedVoice(state)
  }
}
private func voicePermissionCompleted(_ state: VoiceState, allowed: Bool) -> VoiceTransition {
  guard [.requestingMicrophone, .reconnecting, .resuming].contains(state.capture) else { return unchangedVoice(state) }
  guard allowed else { return unchangedVoice(state.replacing(capture: state.captureModel.replacing(intent: .off, capture: .failed(.permissionDenied)))) }
  guard let id = state.startRequestId else { return unchangedVoice(state) }
  let connecting = state.replacing(capture: state.captureModel.replacing(capture: state.resumeProbe ? .resuming : .connecting))
  return reserveVoice(connecting, .bootstrap(requestId: id, muted: state.startMuted))
}
private func voiceBootstrapCompleted(_ state: VoiceState, requestedId: UUID, muted: Bool,
  result: Result<VoiceJoin, VoiceFailure>, current: Bool, proposedId: UUID) -> VoiceTransition {
  switch result {
  case .failure(let error): return current ? failVoiceTransport(state, error, proposedId: proposedId) : unchangedVoice(state)
  case .success(let join):
    guard current, state.isConnecting, state.wantsListening, state.startRequestId == requestedId else {
      return releaseVoiceBootstrap(state, origin: voiceOrigin(join))
    }
    guard join.startRequestId == requestedId else {
      return continueVoice(releaseVoiceBootstrap(state, origin: voiceOrigin(join))) { failVoiceTransport($0, .invalidResponse, proposedId: proposedId) }
    }
    let origin = voiceOrigin(join)
    let connected = state.replacing(capture: state.captureModel.replacing(bootstrapKnown: true, origin: .some(origin), unrecognizedUtterance: .some(nil)))
    let actuallyMuted = muted || state.wantsMuted || state.hasPendingAdmission
    let request = VoiceRequest(generation: state.generation, id: state.execution.nextRequest)
    let reserved = reserveVoice(connected, .connect(join, muted: actuallyMuted), after: physicalVoiceRequests(state))
    return VoiceTransition(state: reserved.state.replacing(execution: reserved.state.execution.replacing(activeCapture: .some(request))), commands: reserved.commands)
  }
}
private func voiceConnectCompleted(_ state: VoiceState, request: VoiceRequest, origin: VoiceOrigin,
  muted: Bool, result: Result<Void, VoiceFailure>, current: Bool, proposedId: UUID) -> VoiceTransition {
  guard current, state.isConnecting, state.captureModel.origin == origin, state.wantsListening || state.hasPendingAdmission else {
    return reserveVoice(state, .disconnect, after: physicalVoiceRequests(state))
  }
  switch result {
  case .failure(let error): return failVoiceTransport(state, error, proposedId: proposedId)
  case .success:
    let capture = state.captureModel.replacing(capture: state.hasPendingAdmission ? .checkingPreviousSpeech : (muted ? .muted : .listening), retryStep: 0, resumeProbe: false)
    let listening = state.replacing(capture: capture)
    let snapshot = reserveVoice(listening, .snapshot(origin, after: state.sequence))
    let languages = continueVoice(snapshot, requestVoiceLanguages)
    let projected = VoiceTransition(state: languages.state, commands: languages.commands + [.refreshConversation])
    let desired = state.wantsMuted || state.hasPendingAdmission
    return muted != desired || state.startMuted != desired ? continueVoice(projected) { requestVoiceMute($0, desired) } : projected
  }
}
private func voiceLocalMuteCompleted(_ state: VoiceState, muted: Bool, result: Result<Void, VoiceFailure>, proposedId: UUID) -> VoiceTransition {
  switch result {
  case .failure(let error): return failVoiceTransport(state, error, proposedId: proposedId)
  case .success:
    guard state.wantsListening, let origin = state.captureModel.origin else { return unchangedVoice(state) }
    return reserveVoice(state, .remoteMute(origin, muted))
  }
}
private func voiceRemoteMuteCompleted(_ state: VoiceState, muted: Bool, result: Result<Void, VoiceFailure>, proposedId: UUID) -> VoiceTransition {
  switch result {
  case .failure(let error): return failVoiceTransport(state, error, proposedId: proposedId)
  case .success:
    guard state.wantsListening, [.listening, .muted, .checkingPreviousSpeech].contains(state.capture) else { return unchangedVoice(state) }
    return unchangedVoice(state.replacing(capture: state.captureModel.replacing(capture: state.hasPendingAdmission ? .checkingPreviousSpeech : (muted ? .muted : .listening),
      muteInFlight: false, tentative: muted ? "" : nil, tentativeUtterance: muted ? .some(nil) : nil)))
  }
}
private func voiceLanguagesCompleted(_ state: VoiceState, _ result: Result<VoiceLanguages, VoiceFailure>) -> VoiceTransition {
  switch result {
  case .success(let value): return unchangedVoice(state.replacing(languages: value.isValid
    ? VoiceLanguageState(languages: value) : VoiceLanguageState(failure: .invalidResponse)))
  case .failure(let error): return unchangedVoice(state.replacing(languages: VoiceLanguageState(failure: error)))
  }
}
private func voiceSnapshotCompleted(_ state: VoiceState, origin: VoiceOrigin,
  result: Result<VoiceSnapshot, VoiceFailure>, proposedId: UUID) -> VoiceTransition {
  switch result {
  case .success(let page):
    let observed = voiceSnapshotObserved(state, requestOrigin: origin, page: page, proposedId: proposedId)
    guard observed.state.captureModel.origin == origin, observed.state.wantsListening || observed.state.hasPendingAdmission else { return observed }
    return continueVoice(observed) { reserveVoice($0, .sleep(milliseconds: 250, purpose: .observation(origin))) }
  case .failure(let error):
    if !state.wantsListening {
      guard state.hasPendingAdmission else { return unchangedVoice(markVoiceChecking(state)) }
      return reserveVoice(markVoiceChecking(state), .sleep(milliseconds: 1000, purpose: .observation(origin)))
    }
    return tracedVoice(failVoiceTransport(state, error, proposedId: proposedId), state: state, cause: .observationFailed)
  }
}
private func voiceSealCompleted(_ state: VoiceState, origin: VoiceOrigin,
  result: Result<VoiceSealResult, VoiceFailure>, proposedId: UUID) -> VoiceTransition {
  guard state.captureModel.drainingOrigin == origin else { return unchangedVoice(state) }
  switch result {
  case .success(let value): return voiceSealed(state, origin: origin, result: value, proposedId: proposedId)
  case .failure:
    return unchangedVoice(state.replacing(capture: state.wantsListening ? state.captureModel.replacing(capture: .paused, resumeProbe: false) : state.captureModel))
  }
}
private func voiceReadyCompleted(_ state: VoiceState, origin: VoiceOrigin, manifest: VoiceAudioManifest,
  result: Result<VoiceSnapshot, VoiceFailure>, proposedId: UUID) -> VoiceTransition {
  guard state.output.prepared == manifest.identity, state.output.current?.identity == manifest.identity,
    !state.output.locallyInterrupted else { return unchangedVoice(state) }
  switch result {
  case .success(let page): return voiceSnapshotObserved(state, requestOrigin: origin, page: page, proposedId: proposedId)
  case .failure: return composeVoiceOutput(unchangedVoice(state), .failed(manifest.identity))
  }
}
private func voiceTimerCompleted(_ state: VoiceState, request: VoiceRequest, purpose: VoiceTimerPurpose) -> VoiceTransition {
  if case .bootstrapCleanup(let origin) = purpose { return retryVoiceBootstrapRelease(state, origin: origin) }
  guard !state.isRetired else { return unchangedVoice(state) }
  switch purpose {
  case .bootstrapCleanup: return unchangedVoice(state)
  case .resolution: return unchangedVoice(state)
  case .captureRetry:
    guard request.generation == state.generation, state.wantsListening,
      [.hostUnavailable, .reconnecting].contains(state.capture) else { return unchangedVoice(state) }
    return unchangedVoice(state.replacing(capture: state.captureModel.replacing(capture: .reconnecting)))
  case .observation(let origin):
    // A reserved poll can contain speech handed before End but not yet known
    // locally. Consume it once; continuation requires intent or pending input.
    guard request.generation == state.generation, state.captureModel.origin == origin
    else { return unchangedVoice(state) }
    return reserveVoice(state, .snapshot(origin, after: state.sequence))
  }
}
