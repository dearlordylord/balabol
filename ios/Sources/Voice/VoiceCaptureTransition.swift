import Foundation

internal func voicePhysicalMedia(_ kind: VoiceOperationKind) -> Bool {
  switch kind { case .permission, .connect, .localMute, .stopMedia, .disconnect, .prepareOutput: true; default: false }
}
private func captureProducer(_ kind: VoiceOperationKind) -> Bool {
  switch kind {
  case .permission, .bootstrap, .connect, .localMute, .remoteMute, .snapshot, .prepareOutput, .ready,
    .sleep(_, .captureRetry), .sleep(_, .observation): true
  default: false
  }
}
internal func requestVoiceMute(_ state: VoiceState, _ muted: Bool) -> VoiceTransition {
  guard state.captureModel.origin != nil, !state.muteInFlight else { return unchangedVoice(state) }
  return reserveVoice(state.replacing(capture: state.captureModel.replacing(muteInFlight: true)), .localMute(muted))
}
internal func progressVoiceCapture(_ state: VoiceState) -> VoiceTransition {
  guard !state.isRetired, state.wantsListening, state.checkpointLoaded,
    [.requestingMicrophone, .reconnecting, .resuming].contains(state.capture),
    state.captureModel.drainingOrigin == nil,
    !hasVoiceOperation(state, where: {
      switch $0 { case .bootstrap, .sleep(_, .captureRetry): true; default: voicePhysicalMedia($0) }
    })
  else { return unchangedVoice(state) }
  let after = state.execution.platformObservation.flatMap { state.execution.operations[$0] == nil ? nil : [$0] } ?? []
  return reserveVoice(state, .permission, after: after)
}
internal func startVoice(_ state: VoiceState, proposedId: UUID, resuming: Bool) -> VoiceTransition {
  guard resuming ? state.canResume : state.canStart else { return unchangedVoice(state) }
  let capture = state.captureModel.replacing(intent: resuming ? state.intent : .listening(muted: false),
    capture: resuming ? .resuming : .requestingMicrophone, startRequestId: .some(proposedId),
    startMuted: (resuming && state.wantsMuted) || state.hasPendingAdmission, bootstrapKnown: false,
    retryStep: 0, origin: .some(nil), snapshotSequence: -1, generation: state.generation + 1, sequence: 0,
    muteInFlight: false, resumeProbe: resuming, tentative: "", tentativeUtterance: .some(nil), unrecognizedUtterance: .some(nil))
  let next = state.replacing(capture: capture, recovery: state.recovery.replacing(admissionFailure: .some(nil)),
    output: VoiceOutputState(), execution: state.execution.replacing(activeCapture: .some(nil)))
  let cancelled = cancelVoice(next) { _, operation in captureProducer(operation.kind) }
  let platform = ensureVoicePlatform(cancelled)
  let restored = continueVoice(platform) { current in
    guard !current.checkpointLoaded, !hasVoiceOperation(current, where: { $0 == .restoreCheckpoint }) else { return unchangedVoice(current) }
    return reserveVoice(current, .restoreCheckpoint)
  }
  guard let draining = state.captureModel.drainingOrigin,
    !hasVoiceOperation(restored.state, where: { if case .seal = $0 { true } else { false } }) else { return restored }
  return continueVoice(restored) { reserveVoice($0, .seal(draining), after: physicalVoiceRequests($0)) }
}
private func ensureVoicePlatform(_ step: VoiceTransition) -> VoiceTransition {
  guard step.state.execution.platformObservation == nil else { return step }
  let barriers = step.state.execution.operations.filter { entry in
    switch entry.value.kind { case .observePlatform, .retirePlatformObservation: true; default: false }
  }.map(\.key).sorted { $0.id < $1.id }
  let reserved = reserveVoice(step.state, .observePlatform, after: barriers)
  let request = VoiceRequest(generation: step.state.generation, id: step.state.execution.nextRequest)
  return VoiceTransition(state: reserved.state.replacing(execution: reserved.state.execution.replacing(platformObservation: .some(request))),
    commands: step.commands + reserved.commands)
}
internal func physicalVoiceRequests(_ state: VoiceState) -> [VoiceRequest] {
  state.execution.operations.filter { voicePhysicalMedia($0.value.kind) }.map(\.key).sorted { $0.id < $1.id }
}
internal func stopVoiceMedia(_ state: VoiceState, capture: Bool, output: Bool, preservingFailureCue: Bool = false) -> VoiceTransition {
  let request = VoiceRequest(generation: state.generation, id: state.execution.nextRequest)
  let stopped = reserveVoice(state, .stopMedia(capture: capture, output: output,
    target: state.output.current?.identity, session: state.sessionId, preservingFailureCue: preservingFailureCue))
  return VoiceTransition(state: stopped.state.replacing(execution: stopped.state.execution.replacing(localStop: .some(request))), commands: stopped.commands)
}
internal func closeVoiceProducer(_ state: VoiceState, origin: VoiceOrigin?, preserveObservation: Bool = false) -> VoiceTransition {
  let cancelled = cancelVoice(state) { _, operation in
    if preserveObservation {
      switch operation.kind { case .snapshot, .sleep(_, .observation): return false; default: break }
    }
    return captureProducer(operation.kind)
  }
  let stopped = continueVoice(cancelled) { stopVoiceMedia($0, capture: true, output: true) }
  // End completes its local stop independently of a noncooperative old mute or
  // connect. Those reservations still fence the next producer in progressCapture.
  let dependencies = (stopped.state.execution.operations.filter { entry in
    if case .disconnect = entry.value.kind { return true }; return false
  }.map(\.key) + (stopped.state.execution.localStop.map { [$0] } ?? [])).sorted { $0.id < $1.id }
  let disconnected = continueVoice(stopped) { reserveVoice($0, .disconnect, after: dependencies) }
  guard let origin, !hasVoiceOperation(disconnected.state, where: { if case .seal(let value) = $0 { value == origin } else { false } }) else { return disconnected }
  return continueVoice(disconnected) { current in reserveVoice(current, .seal(origin), after: current.execution.localStop.map { [$0] } ?? []) }
}
internal func endVoice(_ state: VoiceState, shutdown: Bool) -> VoiceTransition {
  if state.isRetired && !shutdown { return unchangedVoice(state) }
  if !shutdown && [.idle, .ending, .ended].contains(state.capture) { return unchangedVoice(state) }
  let capture = state.captureModel.replacing(intent: .off, capture: state.capture == .idle ? .idle : .ending,
    muteInFlight: false, drainingOrigin: .some(state.captureModel.drainingOrigin ?? state.captureModel.origin),
    isRetired: shutdown, tentative: "", tentativeUtterance: .some(nil), unrecognizedUtterance: .some(nil))
  let next = markVoiceChecking(state.replacing(capture: capture,
    execution: state.execution.replacing(platformObservation: .some(nil), shuttingDown: shutdown)))
  let closed = closeVoiceProducer(next, origin: state.captureModel.origin ?? state.captureModel.drainingOrigin, preserveObservation: !shutdown)
  let platform = continueVoice(closed) { current in
    let observation = current.execution.operations.filter { $0.value.kind == .observePlatform }.map(\.key).sorted { $0.id < $1.id }
    return reserveVoice(current, .retirePlatformObservation, after: observation)
  }
  let cut = composeVoiceOutput(platform, .disconnected)
  return shutdown ? continueVoice(cut) { current in cancelVoice(current) { _, operation in
    switch operation.kind { case .checkpoint, .stopMedia, .disconnect, .seal, .endBootstrap, .sleep(_, .bootstrapCleanup), .interrupt, .retirePlatformObservation: false; default: true }
  } } : cut
}
internal func voiceTransportRetryable(_ error: VoiceFailure) -> Bool {
  switch error {
  case .connection: true
  case .backend(let code, _): ["SessionNotFound", "StartExpired", "VoiceBusy", "Unavailable", "StorageUnavailable"].contains(code)
  default: false
  }
}
internal func failVoiceTransport(_ state: VoiceState, _ error: VoiceFailure, proposedId: UUID) -> VoiceTransition {
  guard !state.isRetired, state.capture != .ending, state.capture != .ended else { return unchangedVoice(state) }
  let paused = state.capture == .paused || state.resumeProbe
  let retry = !paused && state.wantsListening && voiceTransportRetryable(error)
  let expired: Bool = { if case .backend("StartExpired", _) = error { true } else { false } }()
  let busy: Bool = { if case .backend("VoiceBusy", _) = error { true } else { false } }()
  let renewId = state.bootstrapKnown || expired
  let capture = state.captureModel.replacing(intent: paused || retry ? state.intent : .off,
    capture: paused ? .paused : (retry ? (busy ? .reconnecting : .hostUnavailable) : .failed(error)),
    startRequestId: renewId ? .some(proposedId) : nil,
    startMuted: renewId ? state.wantsMuted || state.hasPendingAdmission : nil, bootstrapKnown: renewId ? false : nil,
    origin: .some(nil), snapshotSequence: -1, generation: state.generation + 1, sequence: 0, muteInFlight: false,
    resumeProbe: false, drainingOrigin: .some(state.captureModel.origin ?? state.captureModel.drainingOrigin),
    tentative: "", tentativeUtterance: .some(nil))
  let next = markVoiceChecking(state.replacing(capture: capture, execution: state.execution.replacing(activeCapture: .some(nil))))
  let released = composeVoiceOutput(closeVoiceProducer(next, origin: state.captureModel.origin), .disconnected)
  let closed = VoiceTransition(state: released.state,
    commands: voiceTrace(state, .transportFailed, failure: error) + released.commands)
  guard retry else { return closed }
  let delays = [500, 1000, 2000, 4000, 8000]
  let step = min(state.retryStep, delays.count - 1)
  return continueVoice(closed) { current in reserveVoice(current.replacing(capture: current.captureModel.replacing(retryStep: min(step + 1, delays.count - 1))),
    .sleep(milliseconds: delays[step], purpose: .captureRetry)) }
}
