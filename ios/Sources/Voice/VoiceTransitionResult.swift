import Foundation

internal func unchangedVoice(_ state: VoiceState) -> VoiceTransition {
  VoiceTransition(state: state, commands: [])
}
internal func continueVoice(_ step: VoiceTransition, _ next: (VoiceState) -> VoiceTransition) -> VoiceTransition {
  let result = next(step.state)
  return VoiceTransition(state: result.state, commands: step.commands + result.commands)
}
internal func reserveVoice(_ state: VoiceState, _ work: VoiceWork, after: [VoiceRequest] = []) -> VoiceTransition {
  let request = VoiceRequest(generation: state.generation, id: state.execution.nextRequest)
  let operation = VoiceOperation(kind: VoiceOperationKind(work), cancelling: false)
  let execution = state.execution.replacing(operations: state.execution.operations.merging([request: operation]) { _, new in new },
    nextRequest: request.id + 1)
  return VoiceTransition(state: state.replacing(execution: execution), commands: [.run(request, work, after: after)])
}
internal func removeVoiceOperation(_ state: VoiceState, _ request: VoiceRequest) -> VoiceState {
  state.replacing(execution: state.execution.replacing(operations: state.execution.operations.filter { $0.key != request }))
}
internal func cancelVoice(_ state: VoiceState, where matches: (VoiceRequest, VoiceOperation) -> Bool) -> VoiceTransition {
  let requests = state.execution.operations.filter { !$0.value.cancelling && matches($0.key, $0.value) }.map(\.key).sorted { $0.id < $1.id }
  let operations = state.execution.operations.mapValues { operation in operation }
  let cancelled = requests.reduce(operations) { values, request in
    guard let operation = values[request] else { return values }
    return values.merging([request: VoiceOperation(kind: operation.kind, cancelling: true)]) { _, new in new }
  }
  return VoiceTransition(state: state.replacing(execution: state.execution.replacing(operations: cancelled)),
    commands: requests.isEmpty ? [] : [.cancel(requests)])
}
internal func hasVoiceOperation(_ state: VoiceState, where matches: (VoiceOperationKind) -> Bool) -> Bool {
  state.execution.operations.values.contains { matches($0.kind) }
}
internal func voiceOrigin(_ join: VoiceJoin) -> VoiceOrigin {
  VoiceOrigin(sessionId: join.sessionId, backendIncarnationId: join.backendIncarnationId)
}
