import Foundation

enum VoiceOutputEvent {
  case observed(sequence: Int, VoiceOutput)
  case inputAccepted(UUID)
  case audioReceived(VoiceOutputIdentity)
  case cut(nextInput: UUID?, pendingInputs: [UUID])
  case failed(VoiceOutputIdentity)
  case disconnected
}

enum VoiceOutputCommand {
  case prepare(VoiceAudioManifest)
  case suppress(VoiceOutputIdentity?)
}

extension VoiceOutputState {
  mutating func transition(_ event: VoiceOutputEvent) -> [VoiceOutputCommand] {
    switch event {
    case .disconnected:
      closed = true
      current = nil
      prepared = nil
      receivedAudio = false
      locallyInterrupted = false
      unavailable = false
      return [.suppress(nil)]
    case .audioReceived(let identity):
      guard prepared == identity, current?.identity == identity, !locallyInterrupted else {
        return []
      }
      receivedAudio = true
      return []
    case .inputAccepted(let id):
      if gated, id != cutInput, id != cutAcceptedInput, !cutPendingInputs.contains(id) {
        allowedInput = id
      }
      lastAcceptedInput = id
      return []
    case .cut(let nextInput, let pendingInputs):
      // A discarded utterance cannot reopen this baseline. A later cut takes
      // a fresh baseline so repeating a previously accepted receipt cannot resume.
      cutInput = current?.inputDeliveryId
      cutAcceptedInput = lastAcceptedInput
      cutPendingInputs = Array(pendingInputs.prefix(2))
      gated = true
      allowedInput = nextInput
      locallyInterrupted = locallyInterrupted || current?.isActive == true
      prepared = nil
      let target = current?.isActive == true ? current?.identity : nil
      if target == interrupted { return [.suppress(nil)] }
      interrupted = target
      return [.suppress(target)]
    case .failed(let identity):
      guard current?.identity == identity else { return [] }
      unavailable = true
      prepared = nil
      return [.suppress(nil)]
    case .observed(let sequence, let output):
      guard !closed, sequence > self.sequence else { return [] }
      self.sequence = sequence
      if gated && output.inputDeliveryId != allowedInput {
        if current == nil {
          current = output
          locallyInterrupted = output.isActive || output.status == .interrupted
          unavailable = output.status == .failed
        }
        guard output.isActive, output.identity != interrupted else { return [] }
        interrupted = output.identity
        // No subscription was authorized for this late manifest. It needs only
        // a server cut; suppressing an unrelated fresh track would be incorrect.
        return [.suppress(output.identity)]
      }
      if let current, current.identity == output.identity {
        let terminal: Set<VoiceOutput.Status> = [.delivered, .interrupted, .failed]
        if terminal.contains(current.status)
          || (current.status == .playing && [.preparing, .awaitingReady].contains(output.status))
        {
          return []
        }
      }
      if current?.identity != output.identity { receivedAudio = false }
      current = output
      locallyInterrupted = output.status == .interrupted
      unavailable = output.status == .failed
      if output.status == .delivered {
        prepared = nil
        return []
      }
      if [.interrupted, .failed].contains(output.status) {
        prepared = nil
        return [.suppress(nil)]
      }
      guard let manifest = output.manifest, prepared != output.identity else { return [] }
      prepared = output.identity
      return [.prepare(manifest)]
    }
  }
}
