import Foundation

internal func composeVoiceOutput(_ step: VoiceTransition, _ event: VoiceOutputEvent) -> VoiceTransition {
  let projected = transitionVoiceOutput(step.state.output, event)
  return projected.commands.reduce(VoiceTransition(state: step.state.replacing(output: projected.state), commands: step.commands)) { result, command in
    continueVoice(result) { state in
      switch command {
      case .prepare: return unchangedVoice(state) // The immutable prepared identity reserves intent; progress waits for physical quiescence.
      case .suppress(let target, let stopLocal, let preservingFailureCue): return suppressVoiceOutput(state, target: target, stopLocal: stopLocal, preservingFailureCue: preservingFailureCue)
      }
    }
  }
}
private func outputWork(_ kind: VoiceOperationKind) -> Bool {
  switch kind { case .prepareOutput, .ready: true; default: false }
}
private func ensureVoiceOutputStop(_ state: VoiceState, preservingFailureCue: Bool = false) -> VoiceTransition {
  if let entry = state.execution.operations.filter({ entry in
    if case .stopMedia(_, true, _, _, _) = entry.value.kind { return true }; return false
  }).max(by: { $0.key.id < $1.key.id }) {
    return unchangedVoice(state.replacing(execution: state.execution.replacing(localStop: .some(entry.key))))
  }
  return stopVoiceMedia(state, capture: false, output: true, preservingFailureCue: preservingFailureCue)
}
private func suppressVoiceOutput(_ state: VoiceState, target: VoiceOutputIdentity?, stopLocal: Bool, preservingFailureCue: Bool) -> VoiceTransition {
  let stopped = stopLocal ? continueVoice(cancelVoice(state) { _, operation in outputWork(operation.kind) }) { ensureVoiceOutputStop($0, preservingFailureCue: preservingFailureCue) }
    : unchangedVoice(state)
  guard let target, let origin = state.captureModel.origin else { return stopped }
  let after = stopLocal ? stopped.state.execution.localStop.map { [$0] } ?? [] : []
  return continueVoice(stopped) { reserveVoice($0, .interrupt(origin, target), after: after) }
}
internal func cutVoiceOutput(_ state: VoiceState, nextInput: UUID? = nil) -> VoiceTransition {
  let capture: VoiceCaptureState
  if case .captureDiscontinuity = state.inputNotice {
    capture = state.captureModel.replacing(inputNotice: .some(nil))
  } else { capture = state.captureModel }
  let cleared = state.replacing(capture: capture, execution: state.execution.replacing(pendingFailureCue: .some(nil)))
  let cut = composeVoiceOutput(unchangedVoice(cleared), .cut(nextInput: nextInput, pendingInputs: state.pendingAssociations.map(\.deliveryId)))
  return VoiceTransition(state: cut.state, commands: [.cancelGenerationCue] + voiceTrace(state, .cut) + cut.commands)
}
internal func progressVoiceOutput(_ state: VoiceState) -> VoiceTransition {
  guard !state.isRetired, [.listening, .muted].contains(state.capture), !state.output.closed,
    !state.output.locallyInterrupted, let current = state.output.current,
    current.isActive, let manifest = current.manifest, state.output.prepared == current.identity,
    state.captureModel.origin?.sessionId == manifest.sessionId,
    !hasVoiceOperation(state, where: {
      switch $0 { case .prepareOutput, .stopMedia(_, true, _, _, _): true; default: false }
    }), state.execution.preparedOutput != current.identity else { return unchangedVoice(state) }
  return reserveVoice(state, .prepareOutput(manifest))
}
internal func outputVoicePrepared(_ state: VoiceState, request: VoiceRequest, manifest: VoiceAudioManifest,
  result: Result<Void, VoiceFailure>) -> VoiceTransition {
  let active = request.generation == state.generation && !state.isRetired && !state.output.locallyInterrupted
    && state.output.prepared == manifest.identity && state.output.current?.identity == manifest.identity
  guard active, let origin = state.captureModel.origin, [.listening, .muted].contains(state.capture) else {
    return ensureVoiceOutputStop(state)
  }
  switch result {
  case .success:
    let prepared = state.replacing(execution: state.execution.replacing(preparedOutput: .some(manifest.identity)))
    return reserveVoice(prepared, .ready(origin, manifest))
  case .failure: return composeVoiceOutput(unchangedVoice(state), .failed(manifest.identity))
  }
}

/// This is one failure notification waiting on its exact physical stop, never a
/// queue of progress sounds. Any input, lifecycle pause or replacement discards it.
internal func progressVoiceFailureCue(_ state: VoiceState) -> VoiceTransition {
  guard let target = state.execution.pendingFailureCue else { return unchangedVoice(state) }
  let cleared = state.replacing(execution: state.execution.replacing(pendingFailureCue: .some(nil)))
  guard [.listening, .muted].contains(state.capture), !state.output.closed,
    !state.output.gated || state.output.allowedInput == target.inputDeliveryId,
    let current = state.output.current, current.identity == target,
    current.status != .interrupted && current.status != .delivered
  else { return unchangedVoice(cleared) }
  guard current.status == .failed,
    !hasVoiceOperation(state, where: { if case .stopMedia(_, true, _, _, _) = $0 { true } else { false } })
  else { return unchangedVoice(state) }
  return VoiceTransition(state: cleared, commands: [.generationCue(.failed)])
}
