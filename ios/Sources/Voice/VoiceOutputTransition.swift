import Foundation

internal enum VoiceOutputEvent {
  case observed(sequence: Int, VoiceOutput)
  case inputAccepted(UUID)
  case audioReceived(VoiceOutputIdentity)
  case cut(nextInput: UUID?, pendingInputs: [UUID])
  case failed(VoiceOutputIdentity)
  case disconnected
}
internal enum VoiceOutputCommand {
  case prepare(VoiceAudioManifest)
  case suppress(VoiceOutputIdentity?, stopLocal: Bool)
}
internal struct VoiceOutputStep {
  let state: VoiceOutputState
  let commands: [VoiceOutputCommand]
}
internal func transitionVoiceOutput(_ state: VoiceOutputState, _ event: VoiceOutputEvent) -> VoiceOutputStep {
  switch event {
  case .disconnected:
    return VoiceOutputStep(state: state.replacing(current: .some(nil), locallyInterrupted: false,
      unavailable: false, receivedAudio: false, closed: true, prepared: .some(nil)),
      commands: [.suppress(nil, stopLocal: true)])
  case .audioReceived(let identity):
    guard state.prepared == identity, state.current?.identity == identity, !state.locallyInterrupted else {
      return VoiceOutputStep(state: state, commands: [])
    }
    return VoiceOutputStep(state: state.replacing(receivedAudio: true), commands: [])
  case .inputAccepted(let id):
    let allow = state.gated && id != state.cutInput && id != state.cutAcceptedInput && !state.cutPendingInputs.contains(id)
    return VoiceOutputStep(state: state.replacing(lastAcceptedInput: .some(id),
      allowedInput: allow ? .some(id) : nil), commands: [])
  case .cut(let next, let pending):
    let target = state.current?.isActive == true ? state.current?.identity : nil
    let nextState = state.replacing(locallyInterrupted: state.locallyInterrupted || state.current?.isActive == true,
      cutInput: .some(state.current?.inputDeliveryId), cutAcceptedInput: .some(state.lastAcceptedInput),
      cutPendingInputs: Array(pending.prefix(2)), allowedInput: .some(next), gated: true,
      prepared: .some(nil), interrupted: .some(target))
    return VoiceOutputStep(state: nextState, commands: [.suppress(target == state.interrupted ? nil : target, stopLocal: true)])
  case .failed(let identity):
    guard state.current?.identity == identity else { return VoiceOutputStep(state: state, commands: []) }
    return VoiceOutputStep(state: state.replacing(unavailable: true, prepared: .some(nil)), commands: [.suppress(nil, stopLocal: true)])
  case .observed(let sequence, let value): return observeOutput(state, sequence: sequence, value: value)
  }
}
private func observeOutput(_ state: VoiceOutputState, sequence: Int, value: VoiceOutput) -> VoiceOutputStep {
  guard !state.closed, sequence > state.sequence else { return VoiceOutputStep(state: state, commands: []) }
  let advanced = state.replacing(sequence: sequence)
  if state.gated && value.inputDeliveryId != state.allowedInput { return rejectOutput(advanced, value) }
  if let current = state.current, current.identity == value.identity {
    if [.delivered, .interrupted, .failed].contains(current.status)
      || (current.status == .playing && [.preparing, .awaitingReady].contains(value.status)) {
      return VoiceOutputStep(state: advanced, commands: [])
    }
  }
  let selected = advanced.replacing(current: .some(value), locallyInterrupted: value.status == .interrupted,
    unavailable: value.status == .failed, receivedAudio: state.current?.identity == value.identity ? nil : false)
  if value.status == .delivered { return VoiceOutputStep(state: selected.replacing(prepared: .some(nil)), commands: []) }
  if [.interrupted, .failed].contains(value.status) {
    return VoiceOutputStep(state: selected.replacing(prepared: .some(nil)), commands: [.suppress(nil, stopLocal: true)])
  }
  guard let manifest = value.manifest, selected.prepared != value.identity else {
    return VoiceOutputStep(state: selected, commands: [])
  }
  return VoiceOutputStep(state: selected.replacing(prepared: .some(value.identity)), commands: [.prepare(manifest)])
}
private func rejectOutput(_ state: VoiceOutputState, _ value: VoiceOutput) -> VoiceOutputStep {
  let selected = state.current == nil ? state.replacing(current: .some(value),
    locallyInterrupted: value.isActive || value.status == .interrupted, unavailable: value.status == .failed) : state
  guard value.isActive, value.identity != state.interrupted else { return VoiceOutputStep(state: selected, commands: []) }
  return VoiceOutputStep(state: selected.replacing(interrupted: .some(value.identity)), commands: [.suppress(value.identity, stopLocal: false)])
}
