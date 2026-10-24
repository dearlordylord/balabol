import Foundation

@testable import Voice

/// Explicit context facts abstract the surrounding capture owner; its lifecycle
/// transitions are checked by the subsequent composition model, not recreated here.
struct VoicePreparationITFMapping {
  let output = VoiceOutputITFMapping()
  func initial() throws -> VoiceState {
    VoiceState().replacing(
      capture: VoiceCaptureState(
        intent: .listening(muted: false), capture: .listening,
        origin: try origin(.record(["session": .integer(1), "incarnation": .integer(1)])),
        generation: 1))
  }
  func origin(_ value: ITFValue) throws -> VoiceOrigin {
    let fields = try value.record(["session", "incarnation"])
    return try VoiceOrigin(
      sessionId: output.identities.uuid(.session, fields["session"]!.integer()),
      backendIncarnationId: output.identities.uuid(.incarnation, fields["incarnation"]!.integer()))
  }
  func project(_ value: VoiceOrigin) throws -> ITFValue {
    try .record([
      "session": .integer(output.identities.symbol(.session, value.sessionId)),
      "incarnation": .integer(output.identities.symbol(.incarnation, value.backendIncarnationId)),
    ])
  }
  func request(_ value: ITFValue) throws -> VoiceRequest {
    let fields = try value.record(["generation", "id"])
    let generation = try fields["generation"]!.integer()
    let id = try fields["id"]!.integer()
    guard (1...2).contains(generation), id > 0 else {
      throw VoiceITFError.invalid("request domain")
    }
    return VoiceRequest(generation: generation, id: id)
  }
  func project(_ value: VoiceRequest) -> ITFValue {
    .record(["generation": .integer(value.generation), "id": .integer(value.id)])
  }
  func apply(_ event: ITFValue, state: VoiceState) throws -> VoiceTransition {
    let (tag, payload) = try event.variant()
    switch tag {
    case "Project": return try composeVoiceOutput(unchangedVoice(state), output.event(payload))
    case "Progress":
      guard payload == .unit else { throw VoiceITFError.invalid("Progress payload") }
      return progressVoiceOutput(state)
    case "Context":
      let fields = try payload.record(["generation", "retired", "capture", "origin"])
      let generation = try fields["generation"]!.integer()
      guard (1...2).contains(generation) else { throw VoiceITFError.invalid("generation domain") }
      let (captureTag, unit) = try fields["capture"]!.variant()
      guard unit == .unit else { throw VoiceITFError.invalid("capture payload") }
      let capture: VoiceState.Capture
      switch captureTag {
      case "Listening": capture = .listening
      case "Muted": capture = .muted
      case "Paused": capture = .paused
      default: throw VoiceITFError.invalid("capture domain")
      }
      let origin = try fields["origin"]!.optional(origin)
      let next = try state.replacing(
        capture: state.captureModel.replacing(
          capture: capture, origin: .some(origin),
          generation: generation, isRetired: fields["retired"]!.boolean()))
      return unchangedVoice(next)
    case "Complete":
      let fields = try payload.record(["request", "result"])
      let request = try request(fields["request"]!)
      let (resultTag, unit) = try fields["result"]!.variant()
      guard unit == .unit else { throw VoiceITFError.invalid("result payload") }
      let result: VoiceWorkResult
      switch resultTag {
      case "Cancelled": result = .cancelled
      case "Succeeded", "WorkFailed":
        if let operation = state.execution.operations[request] {
          switch operation.kind {
          case .prepareOutput:
            result = .outputPrepared(
              resultTag == "Succeeded" ? .success(()) : .failure(.connection))
          case .ready(let origin, _), .interrupt(let origin, _):
            let page = VoiceSnapshot(
              sessionId: origin.sessionId, status: "listening", muted: false,
              sequence: state.sequence, backendIncarnationId: origin.backendIncarnationId,
              events: [], nextAfter: nil)
            if case .ready = operation.kind {
              result = .ready(resultTag == "Succeeded" ? .success(page) : .failure(.connection))
            } else {
              result = .interrupted(
                resultTag == "Succeeded" ? .success(page) : .failure(.connection))
            }
          case .stopMedia: result = .stopped
          default: throw VoiceITFError.invalid("operation outside preparation model")
          }
        } else {
          result = .outputPrepared(.success(()))
        }
      default: throw VoiceITFError.invalid("result domain")
      }
      return try completeVoice(
        state, request: request, result: result, proposedId: output.identities.uuid(.proposal, 1))
    default: throw VoiceITFError.invalid("unknown preparation event \(tag)")
    }
  }
  func project(_ state: VoiceState) throws -> ITFValue {
    let capture: String
    switch state.capture {
    case .listening: capture = "Listening"
    case .muted: capture = "Muted"
    case .paused: capture = "Paused"
    default: throw VoiceITFError.invalid("unexpected capture outside model")
    }
    let operations = try state.execution.operations.sorted {
      ($0.key.generation, $0.key.id) < ($1.key.generation, $1.key.id)
    }.map { request, operation in
      try ITFValue.record([
        "request": project(request), "kind": project(operation.kind, state: state),
        "cancelling": .boolean(operation.cancelling),
      ])
    }
    return try .record([
      "output": output.project(state.output), "generation": .integer(state.generation),
      "retired": .boolean(state.isRetired), "capture": .variant(capture, .unit),
      "origin": .optional(state.origin, project), "operations": .list(operations),
      "nextRequest": .integer(state.execution.nextRequest),
      "preparedOutput": .optional(state.execution.preparedOutput, output.project),
      "localStop": .optional(state.execution.localStop, project),
    ])
  }
  func project(_ kind: VoiceOperationKind, state: VoiceState) throws -> ITFValue {
    switch kind {
    case .prepareOutput(let manifest):
      return try .variant("PrepareWork", project(manifest, state: state))
    case .ready(let origin, let manifest):
      return try .variant(
        "ReadyWork",
        .record(["origin": project(origin), "output": project(manifest, state: state)]))
    case .stopMedia(let capture, let playback, let target, let session, _):
      guard !capture, playback else { throw VoiceITFError.invalid("unexpected stop resources") }
      return try .variant(
        "StopWork",
        .record([
          "target": .optional(target, output.project),
          "session": .optional(session) { try .integer(output.identities.symbol(.session, $0)) },
        ]))
    case .interrupt(let origin, let target):
      return try .variant(
        "InterruptWork", .record(["origin": project(origin), "target": output.project(target)]))
    default: throw VoiceITFError.invalid("unexpected work outside preparation model")
    }
  }
  private func project(_ manifest: VoiceAudioManifest, state: VoiceState) throws -> ITFValue {
    try output.project(manifest)
  }
  func project(_ commands: [VoiceEffectCommand], state: VoiceState) throws -> ITFValue {
    try .list(
      commands.compactMap { command in
        switch command {
        case .run(let request, let work, let after):
          return try .variant(
            "Run",
            .record([
              "request": project(request), "kind": project(VoiceOperationKind(work), state: state),
              "after": .list(after.map(project)),
            ]))
        case .cancel(let requests): return .variant("CancelWork", .list(requests.map(project)))
        // The model owns playout preparation, not the independently fenced
        // microphone-engine lifetime. Keep all Room work dependencies above.
        case .microphoneLifetime: return nil
        #if DEBUG
          case .trace: return nil
        #endif
        default: throw VoiceITFError.invalid("unexpected effect command outside model")
        }
      })
  }
}
