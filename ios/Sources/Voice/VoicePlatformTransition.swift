import Foundation

internal func platformVoice(_ state: VoiceState, event: VoicePlatformEvent) -> VoiceTransition {
  guard state.wantsListening else { return unchangedVoice(state) }
  switch event {
  case .resumeRecommended, .servicesReset, .routeChanged(false): return unchangedVoice(state)
  case .interrupted, .servicesLost, .routeChanged(true):
    guard ![.paused, .ending, .ended].contains(state.capture) else { return unchangedVoice(state) }
    let origin = state.captureModel.origin
    let capture = state.captureModel.replacing(capture: .paused, origin: .some(nil),
      generation: state.generation + 1, muteInFlight: false, resumeProbe: false,
      drainingOrigin: .some(origin), tentative: "", tentativeUtterance: .some(nil))
    let paused = markVoiceChecking(state.replacing(capture: capture,
      execution: state.execution.replacing(activeCapture: .some(nil))))
    let closed = closeVoiceProducer(paused, origin: origin)
    let cut = composeVoiceOutput(closed, .cut(nextInput: nil, pendingInputs: paused.pendingAssociations.map(\.deliveryId)))
    let commands: [VoiceEffectCommand] = cut.state.execution.localStop.map { [.interruptConversation(paused.pendingAssociations.map(\.deliveryId), after: $0)] } ?? []
    return VoiceTransition(state: cut.state, commands: voiceTrace(state, .platform) + cut.commands + commands)
  }
}
