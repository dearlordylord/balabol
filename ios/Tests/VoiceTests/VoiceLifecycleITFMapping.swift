import Foundation

@testable import Voice

/// Each lifecycle event enters the actual composed transition. The initial
/// listening owner is reached by the same transition, not constructed by fiat.
struct VoiceLifecycleITFMapping {
  let output = VoiceOutputITFMapping()
  let preparation = VoicePreparationITFMapping()

  func origin(_ symbol: Int) throws -> VoiceOrigin {
    try VoiceOrigin(
      sessionId: output.identities.uuid(.session, symbol),
      backendIncarnationId: output.identities.uuid(.incarnation, symbol))
  }
  func initial() throws -> VoiceState {
    let proposal = try output.identities.uuid(.proposal, 1)
    let join = try join(origin: origin(1), proposal: proposal)
    let events: [VoiceFeatureEvent] = [
      .start,
      .completed(.init(generation: 1, id: 1), .platformObserved),
      .completed(.init(generation: 1, id: 2), .restored(.success([]))),
      .completed(.init(generation: 1, id: 3), .permission(true)),
      .completed(.init(generation: 1, id: 4), .bootstrapped(.success(join))),
      .completed(.init(generation: 1, id: 5), .connected(.success(()))),
      .completed(.init(generation: 1, id: 7), .languages(.success(languages))),
    ]
    var state = VoiceState()
    for event in events {
      state = try settleMicrophoneLifetime(
        transitionVoice(state, VoiceInput(event: event, proposedStartRequestId: proposal))).state
    }
    return state
  }
  func apply(_ event: ITFValue, state: VoiceState) throws -> VoiceTransition {
    try settleMicrophoneLifetime(transitionVoice(state, input(event, state: state)))
  }

  /// This model abstracts the SDK prepared-engine owner as succeeding between
  /// Room actions. Supply its real correlated success fact, never overwrite it.
  /// Delayed, failed and noncooperative setters have separate native tests.
  private func settleMicrophoneLifetime(_ step: VoiceTransition) throws -> VoiceTransition {
    let lifetime = step.state.execution.microphoneLifetime
    guard lifetime.revision > lifetime.settledRevision else { return step }
    let settled = transitionVoice(step.state, VoiceInput(
      event: .microphoneLifetimeSettled(lifetime.revision, .success(())), proposedStartRequestId: UUID()))
    let restoredProjection = settled.state.replacing(execution:
      settled.state.execution.replacing(microphoneLifetime: lifetime))
    guard restoredProjection == step.state else {
      throw VoiceITFError.invalid("SDK lifetime settlement changed modeled Room state")
    }
    for command in settled.commands {
      #if DEBUG
        if case .trace = command { continue }
      #endif
      throw VoiceITFError.invalid("SDK lifetime settlement emitted a modeled work/cancel/dependency command")
    }
    return VoiceTransition(state: settled.state, commands: step.commands + settled.commands)
  }

  var languages: VoiceLanguages {
    VoiceLanguages(allowedLanguages: ["en"], supportedLanguages: ["en"])
  }
  func join(origin: VoiceOrigin, proposal: UUID) throws -> VoiceJoin {
    VoiceJoin(
      sessionId: origin.sessionId, startRequestId: proposal,
      backendIncarnationId: origin.backendIncarnationId, joinDeadlineAt: 9_999_999_999_999,
      controlDeadlineAt: 9_999_999_999_999, roomName: "fixture-room",
      participantIdentity: "fixture-participant",
      backendParticipantIdentity: try output.identities.uuid(.publisher, 1),
      mediaUrl: "wss://fixture.invalid",
      token: "fixture", controlToken: "fixture", expiresAt: 9_999_999_999_999)
  }
  func request(_ value: ITFValue) throws -> VoiceRequest {
    let fields = try value.record(["generation", "id"])
    let generation = try fields["generation"]!.integer()
    let id = try fields["id"]!.integer()
    guard generation > 0, id > 0 else { throw VoiceITFError.invalid("lifecycle request domain") }
    return VoiceRequest(generation: generation, id: id)
  }
  func page(_ value: ITFValue, state: VoiceState) throws -> VoiceSnapshot {
    let fields = try value.record(["origin", "sequence", "firstSequence", "ended", "output"])
    let origin = try preparation.origin(fields["origin"]!)
    return try VoiceSnapshot(
      sessionId: origin.sessionId,
      status: fields["ended"]!.boolean() ? "ended" : "listening", muted: state.wantsMuted,
      sequence: fields["sequence"]!.integer(), backendIncarnationId: origin.backendIncarnationId,
      events: [], nextAfter: nil, firstSequence: fields["firstSequence"]!.integer(),
      output: fields["output"]!.optional(output.output))
  }
  func input(_ value: ITFValue, state: VoiceState) throws -> VoiceInput {
    let (tag, payload) = try value.variant()
    let event: VoiceFeatureEvent
    var proposal = try output.identities.uuid(.proposal, 1)
    switch tag {
    case "Speech": event = try .speech(request(payload))
    case "SpeechIntent":
      try unit(payload)
      event = .speechIntent
    case "InputIntent": event = try .inputIntent(output.identities.uuid(.input, payload.integer()))
    case "PlatformPause": event = try .platform(request(payload), .interrupted)
    case "Resume":
      proposal = try output.identities.uuid(.proposal, payload.integer())
      event = .resume
    case "End":
      try unit(payload)
      event = .end
    case "Shutdown":
      try unit(payload)
      event = .shutdown
    case "Mute":
      try unit(payload)
      event = .mute
    case "CaptureFailed":
      let fields = try payload.record(["request", "proposal"])
      event = try .captureFailed(request(fields["request"]!))
      proposal = try output.identities.uuid(.proposal, fields["proposal"]!.integer())
    case "AudioReceived":
      let fields = try payload.record(["request", "identity"])
      event = try .audioReceived(request(fields["request"]!), output.identity(fields["identity"]!))
    case "Complete":
      let fields = try payload.record(["request", "result", "proposal"])
      let request = try request(fields["request"]!)
      proposal = try output.identities.uuid(.proposal, fields["proposal"]!.integer())
      event = try .completed(request, result(fields["result"]!, request: request, state: state))
    default: throw VoiceITFError.invalid("unknown lifecycle event \(tag)")
    }
    return VoiceInput(event: event, proposedStartRequestId: proposal)
  }
  func unit(_ value: ITFValue) throws {
    guard value == .unit else { throw VoiceITFError.invalid("expected unit payload") }
  }
  func result(_ value: ITFValue, request: VoiceRequest, state: VoiceState) throws -> VoiceWorkResult
  {
    let (tag, payload) = try value.variant()
    switch tag {
    case "PermissionResult": return try .permission(payload.boolean())
    case "LanguagesResult":
      try unit(payload)
      return .languages(.success(languages))
    case "Bootstrapped":
      let fields = try payload.record(["origin", "proposal"])
      return try .bootstrapped(
        .success(
          join(
            origin: preparation.origin(fields["origin"]!),
            proposal: output.identities.uuid(.proposal, fields["proposal"]!.integer()))))
    case "SnapshotResult": return try .snapshot(.success(page(payload, state: state)))
    case "Sealed": return try .sealed(.success(.ended(page(payload, state: state))))
    case "ProducerUnavailable":
      let origin = try preparation.origin(payload)
      return .sealed(
        .success(
          .producerUnavailable(
            sessionId: origin.sessionId, backendIncarnationId: origin.backendIncarnationId)))
    case "ReadyResult": return try .ready(.success(page(payload, state: state)))
    case "InterruptedResult": return try .interrupted(.success(page(payload, state: state)))
    case "SealRejected":
      try unit(payload)
      return .sealed(.failure(.invalidResponse))
    case "Failed":
      try unit(payload)
      return try failure(state.execution.operations[request]?.kind)
    default:
      try unit(payload)
      switch tag {
      case "Connected": return .connected(.success(()))
      case "LocalMuted": return .localMuted(.success(()))
      case "RemoteMuted": return .remoteMuted(.success(()))
      case "OutputPrepared": return .outputPrepared(.success(()))
      case "BootstrapEnded": return .bootstrapEnded(.success(()))
      case "Stopped": return .stopped
      case "Disconnected": return .disconnected
      case "PlatformObserved": return .platformObserved
      case "PlatformRetired": return .platformRetired
      case "Elapsed": return .elapsed
      case "Cancelled": return .cancelled
      default: throw VoiceITFError.invalid("unknown lifecycle result \(tag)")
      }
    }
  }
  private func failure(_ kind: VoiceOperationKind?) throws -> VoiceWorkResult {
    guard let kind else { throw VoiceITFError.invalid("failure without owned operation") }
    switch kind {
    case .languages: return .languages(.failure(.connection))
    case .bootstrap: return .bootstrapped(.failure(.connection))
    case .connect: return .connected(.failure(.connection))
    case .localMute: return .localMuted(.failure(.connection))
    case .remoteMute: return .remoteMuted(.failure(.connection))
    case .snapshot: return .snapshot(.failure(.connection))
    case .seal: return .sealed(.failure(.connection))
    case .endBootstrap: return .bootstrapEnded(.failure(.connection))
    case .prepareOutput: return .outputPrepared(.failure(.connection))
    case .ready: return .ready(.failure(.connection))
    case .interrupt: return .interrupted(.failure(.connection))
    case .sleep: return .timerFailed(.connection)
    default: throw VoiceITFError.invalid("failure outside modeled result boundary")
    }
  }
}
