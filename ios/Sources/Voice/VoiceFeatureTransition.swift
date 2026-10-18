import Foundation

/// Sole feature decision entry: commit the returned value before interpreting
/// any commands. Async work reports facts and cannot read this state later.
internal func transitionVoice(_ state: VoiceState, _ input: VoiceInput) -> VoiceTransition {
  let decided = decideVoice(state, input)
  let checkpoint = continueVoice(decided, progressVoiceCheckpoint)
  let recovery = continueVoice(checkpoint, progressVoiceResolution)
  let observation = continueVoice(recovery, progressVoiceObservation)
  let capture = continueVoice(observation, progressVoiceCapture)
  let outputWork = continueVoice(capture, progressVoiceOutput)
  let output = continueVoice(outputWork, progressVoiceFailureCue)
  #if DEBUG
    let traces = state.output == output.state.output ? [] : voiceTrace(output.state, .output)
    return VoiceTransition(state: output.state, commands: output.commands + traces)
  #else
    return output
  #endif
}
private func decideVoice(_ state: VoiceState, _ input: VoiceInput) -> VoiceTransition {
  if case .completed(let request, let result) = input.event {
    return completeVoice(state, request: request, result: result, proposedId: input.proposedStartRequestId)
  }
  guard !state.isRetired else { return unchangedVoice(state) }
  switch input.event {
  case .generationCue(let input, let response, let cue):
    guard [.listening, .muted].contains(state.capture), !state.output.closed,
      !state.output.gated || state.output.allowedInput == input
    else { return unchangedVoice(state) }
    if let current = state.output.current, current.responseId == response {
      // Speech already playing wins. A known failure may signal only after this
      // exact output becomes terminal and its physical stop has completed.
      if cue == .failed, current.inputDeliveryId == input, state.output.receivedAudio {
        let pending = state.replacing(execution: state.execution.replacing(pendingFailureCue: .some(current.identity)))
        if current.isActive {
          let retired = pending.replacing(output: pending.output.replacing(current: .some(VoiceOutput(failing: current))))
          return composeVoiceOutput(unchangedVoice(retired), .failed(current.identity))
        }
        if current.status == .failed, hasVoiceOperation(state, where: {
          if case .stopMedia(_, true, _, _, _) = $0 { true } else { false }
        }) { return unchangedVoice(pending) }
      }
      guard current.inputDeliveryId == input,
        current.isActive || (cue == .failed && current.status == .failed),
        !state.output.receivedAudio || (cue == .failed && current.status == .failed)
      else { return unchangedVoice(state) }
    } else if state.output.current != nil && state.output.allowedInput != input {
      return unchangedVoice(state)
    }
    return VoiceTransition(state: state, commands: [.generationCue(cue)])
  case .cancelGenerationCue:
    let cleared = state.replacing(execution: state.execution.replacing(pendingFailureCue: .some(nil)))
    return VoiceTransition(state: cleared, commands: [.cancelGenerationCue])
  case .completed: return unchangedVoice(state)
  case .restore:
    return state.checkpointLoaded || hasVoiceOperation(state, where: { $0 == .restoreCheckpoint }) ? unchangedVoice(state)
      : reserveVoice(state, .restoreCheckpoint)
  case .loadLanguages: return requestVoiceLanguages(state)
  case .start: return startVoice(state, proposedId: input.proposedStartRequestId, resuming: false)
  case .resume: return startVoice(state, proposedId: input.proposedStartRequestId, resuming: true)
  case .mute: return toggleVoiceMute(state, proposedId: input.proposedStartRequestId)
  case .end: return tracedVoice(endVoice(state, shutdown: false), state: state, cause: .end)
  case .shutdown: return tracedVoice(endVoice(state, shutdown: true), state: state, cause: .shutdown)
  case .inputIntent(let id): return tracedVoice(cutVoiceOutput(state, nextInput: id), state: state, cause: .input)
  case .speechIntent: return tracedVoice(cutVoiceOutput(state), state: state, cause: .speech)
  case .platform(let request, let event):
    guard request == state.execution.platformObservation else { return unchangedVoice(state) }
    return platformVoice(state, event: event)
  case .captureFailed(let request):
    guard request == state.execution.activeCapture else { return unchangedVoice(state) }
    return failVoiceTransport(state, .connection, proposedId: input.proposedStartRequestId)
  case .speech(let request):
    guard request == state.execution.activeCapture, state.capture == .listening else { return unchangedVoice(state) }
    return tracedVoice(cutVoiceOutput(state), state: state, cause: .speech)
  case .audioReceived(let request, let identity):
    guard request == state.execution.activeCapture else { return unchangedVoice(state) }
    return composeVoiceOutput(unchangedVoice(state), .audioReceived(identity))
  }
}
internal func requestVoiceLanguages(_ state: VoiceState) -> VoiceTransition {
  guard !state.isRetired, !hasVoiceOperation(state, where: { $0 == .languages }) else { return unchangedVoice(state) }
  return reserveVoice(state, .languages)
}
private func toggleVoiceMute(_ state: VoiceState, proposedId: UUID) -> VoiceTransition {
  guard state.wantsListening, !state.muteInFlight else { return unchangedVoice(state) }
  let next = state.replacing(capture: state.captureModel.replacing(intent: .listening(muted: !state.wantsMuted)))
  if state.isConnecting && state.bootstrapKnown { return failVoiceTransport(next, .connection, proposedId: proposedId) }
  guard [.listening, .muted].contains(state.capture) else { return unchangedVoice(next) }
  return requestVoiceMute(next, next.wantsMuted)
}
internal func voiceTrace(_ state: VoiceState, _ cause: VoiceTraceCause, failure: VoiceFailure? = nil) -> [VoiceEffectCommand] {
  #if DEBUG
    [.trace(cause, target: state.output.current?.identity, status: state.output.current?.status.rawValue,
      failure: failure, session: state.sessionId)]
  #else
    []
  #endif
}
internal func tracedVoice(_ step: VoiceTransition, state: VoiceState, cause: VoiceTraceCause) -> VoiceTransition {
  VoiceTransition(state: step.state, commands: voiceTrace(state, cause) + step.commands)
}
