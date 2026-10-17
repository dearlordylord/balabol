import Foundation

@testable import Voice

extension VoiceLifecycleITFMapping {
  func project(_ state: VoiceState) throws -> ITFValue {
    guard state.checkpointLoaded, state.associations.isEmpty, state.stagedFinals.isEmpty,
      state.admissions.isEmpty, state.tentative.isEmpty
    else {
      throw VoiceITFError.invalid("lifecycle trace left its empty-admission abstraction")
    }
    let capture: String
    switch state.capture {
    case .listening: capture = "Listening"
    case .muted: capture = "Muted"
    case .paused: capture = "Paused"
    case .resuming: capture = "Resuming"
    case .connecting: capture = "Connecting"
    case .hostUnavailable: capture = "HostUnavailable"
    case .reconnecting: capture = "Reconnecting"
    case .ending: capture = "Ending"
    case .ended: capture = "Ended"
    default: throw VoiceITFError.invalid("capture outside lifecycle model")
    }
    let intent: ITFValue
    switch state.intent {
    case .off: intent = .variant("Off", .unit)
    case .listening(let muted): intent = .variant("Listen", .boolean(muted))
    }
    let operations = try state.execution.operations.sorted { $0.key.id < $1.key.id }.map {
      request, operation in
      try ITFValue.record([
        "request": preparation.project(request), "work": work(operation.kind),
        "cancelling": .boolean(operation.cancelling),
      ])
    }
    let releases = try state.execution.bootstrapReleases.sorted {
      ($0.key.sessionId.uuidString, $0.key.backendIncarnationId.uuidString) < (
        $1.key.sessionId.uuidString, $1.key.backendIncarnationId.uuidString
      )
    }.map { origin, release in
      guard release.origin == origin,
        release.lastFailure == nil || release.lastFailure == .connection
      else {
        throw VoiceITFError.invalid("release outside fixed failure abstraction")
      }
      return try ITFValue.record([
        "origin": preparation.project(origin), "lastFailure": .boolean(release.lastFailure != nil),
      ])
    }
    return try .record([
      "output": output.project(state.output), "capture": .variant(capture, .unit), "intent": intent,
      "origin": .optional(state.origin, preparation.project),
      "drainingOrigin": .optional(state.drainingOrigin, preparation.project),
      "generation": .integer(state.generation), "sequence": .integer(state.sequence),
      "snapshotSequence": .integer(state.snapshotSequence),
      "retired": .boolean(state.isRetired), "shuttingDown": .boolean(state.execution.shuttingDown),
      "bootstrapKnown": .boolean(state.bootstrapKnown),
      "startProposal": .optional(state.startRequestId) {
        try .integer(output.identities.symbol(.proposal, $0))
      },
      "startMuted": .boolean(state.startMuted), "resumeProbe": .boolean(state.resumeProbe),
      "retryStep": .integer(state.retryStep),
      "muteInFlight": .boolean(state.muteInFlight), "operations": .list(operations),
      "nextRequest": .integer(state.execution.nextRequest),
      "platformObservation": .optional(state.execution.platformObservation, preparation.project),
      "activeCapture": .optional(state.execution.activeCapture, preparation.project),
      "preparedOutput": .optional(state.execution.preparedOutput, output.project),
      "localStop": .optional(state.execution.localStop, preparation.project),
      "bootstrapReleases": .list(releases),
    ])
  }
  func work(_ kind: VoiceOperationKind) throws -> ITFValue {
    switch kind {
    case .permission: return .variant("Permission", .unit)
    case .languages: return .variant("Languages", .unit)
    case .bootstrap(let id, let muted):
      return try .variant(
        "Bootstrap",
        .record([
          "proposal": .integer(output.identities.symbol(.proposal, id)), "muted": .boolean(muted),
        ]))
    case .connect(let origin, let muted):
      return try .variant(
        "Connect", .record(["origin": preparation.project(origin), "muted": .boolean(muted)]))
    case .localMute(let muted): return .variant("LocalMute", .boolean(muted))
    case .remoteMute(let origin, let muted):
      return try .variant(
        "RemoteMute", .record(["origin": preparation.project(origin), "muted": .boolean(muted)]))
    case .snapshot(let origin, let after):
      return try .variant(
        "Snapshot", .record(["origin": preparation.project(origin), "after": .integer(after)]))
    case .seal(let origin): return try .variant("Seal", preparation.project(origin))
    case .endBootstrap(let origin): return try .variant("EndBootstrap", preparation.project(origin))
    case .stopMedia(let capture, let playback, let target, let session):
      return try .variant(
        "Stop",
        .record([
          "capture": .boolean(capture), "output": .boolean(playback),
          "target": .optional(target, output.project),
          "session": .optional(session) { try .integer(output.identities.symbol(.session, $0)) },
        ]))
    case .disconnect: return .variant("Disconnect", .unit)
    case .prepareOutput(let manifest): return try .variant("Prepare", output.project(manifest))
    case .ready(let origin, let manifest):
      return try .variant(
        "Ready",
        .record(["origin": preparation.project(origin), "output": output.project(manifest)]))
    case .interrupt(let origin, let target):
      return try .variant(
        "Interrupt",
        .record(["origin": preparation.project(origin), "target": output.project(target)]))
    case .sleep(let milliseconds, let purpose):
      return try .variant(
        "Sleep", .record(["milliseconds": .integer(milliseconds), "purpose": timer(purpose)]))
    case .observePlatform: return .variant("ObservePlatform", .unit)
    case .retirePlatformObservation: return .variant("RetirePlatform", .unit)
    default: throw VoiceITFError.invalid("operation outside lifecycle model")
    }
  }
  private func timer(_ purpose: VoiceTimerPurpose) throws -> ITFValue {
    switch purpose {
    case .observation(let origin): return try .variant("Observation", preparation.project(origin))
    case .captureRetry: return .variant("CaptureRetry", .unit)
    case .bootstrapCleanup(let origin):
      return try .variant("BootstrapCleanup", preparation.project(origin))
    case .resolution: throw VoiceITFError.invalid("admission timer outside lifecycle model")
    }
  }
  func commands(_ commands: [VoiceEffectCommand], state: VoiceState) throws -> ITFValue {
    try .list(
      commands.compactMap { command in
        switch command {
        case .run(let request, let actual, let after):
          if case .connect(let actualJoin, _) = actual {
            try validateJoin(actualJoin, state: state)
          }
          return try .variant(
            "Run",
            .record([
              "request": preparation.project(request), "work": work(VoiceOperationKind(actual)),
              "after": .list(after.map(preparation.project)),
            ]))
        case .cancel(let requests):
          return .variant("Cancel", .list(requests.map(preparation.project)))
        case .refreshConversation: return .variant("RefreshConversation", .unit)
        case .generationCue, .cancelGenerationCue:
          throw VoiceITFError.invalid("Progress cues are excluded from lifecycle trace commands")
        case .interruptConversation(let inputs, let after):
          guard inputs.isEmpty else {
            throw VoiceITFError.invalid("admissions outside lifecycle model")
          }
          return .variant("InterruptConversation", .record(["after": preparation.project(after)]))
        #if DEBUG
          // Telemetry records no work and cannot authorize playback or mutate state.
          case .trace: return nil
        #endif
        case .accepted: throw VoiceITFError.invalid("admission outside lifecycle model")
        }
      })
  }
  func validateJoin(_ actual: VoiceJoin, state: VoiceState) throws {
    guard let proposal = state.startRequestId, actual.startRequestId == proposal else {
      throw VoiceITFError.invalid("connect proposal differs from selected bootstrap")
    }
    let expected = try join(
      origin: VoiceOrigin(
        sessionId: actual.sessionId, backendIncarnationId: actual.backendIncarnationId),
      proposal: proposal)
    guard actual.joinDeadlineAt == expected.joinDeadlineAt,
      actual.controlDeadlineAt == expected.controlDeadlineAt,
      actual.roomName == expected.roomName,
      actual.participantIdentity == expected.participantIdentity,
      actual.backendParticipantIdentity == expected.backendParticipantIdentity,
      actual.mediaUrl == expected.mediaUrl,
      actual.token == expected.token, actual.controlToken == expected.controlToken,
      actual.expiresAt == expected.expiresAt
    else {
      throw VoiceITFError.invalid("connect join outside fixed synthetic wire contract")
    }
  }
}
