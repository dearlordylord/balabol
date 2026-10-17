import Foundation

@testable import Voice

/// Mapping only: production reducers own all event-admission decisions.
struct VoiceOutputITFMapping {
  let identities = VoiceITFIdentities()

  func identity(_ value: ITFValue) throws -> VoiceOutputIdentity {
    let fields = try value.record(["input", "response", "epoch"])
    return try VoiceOutputIdentity(
      inputDeliveryId: identities.uuid(.input, fields["input"]!.integer()),
      responseId: identities.uuid(.response, fields["response"]!.integer()),
      outputEpoch: identities.uuid(.epoch, fields["epoch"]!.integer()))
  }
  func project(_ value: VoiceOutputIdentity) throws -> ITFValue {
    try .record([
      "input": .integer(identities.symbol(.input, value.inputDeliveryId)),
      "response": .integer(identities.symbol(.response, value.responseId)),
      "epoch": .integer(identities.symbol(.epoch, value.outputEpoch)),
    ])
  }
  func output(_ value: ITFValue) throws -> VoiceOutput {
    let fields = try value.record(["identity", "status", "manifest", "session"])
    let id = try identity(fields["identity"]!)
    let (status, payload) = try fields["status"]!.variant()
    guard payload == .unit, VoiceOutput.Status(rawValue: status) != nil else {
      throw VoiceITFError.invalid("output status")
    }
    let session = try identities.uuid(.session, fields["session"]!.integer())
    let manifest = try fields["manifest"]!.boolean()
    let wire: [String: Any] = [
      "inputDeliveryId": id.inputDeliveryId.uuidString, "responseId": id.responseId.uuidString,
      "outputEpoch": id.outputEpoch.uuidString, "status": status,
      "error": status == "Failed"
        ? ["code": "AudioUnavailable", "message": "Fixture failure"] : NSNull(),
      "manifest": manifest
        ? [
          "sessionId": session.uuidString, "inputDeliveryId": id.inputDeliveryId.uuidString,
          "responseId": id.responseId.uuidString, "outputEpoch": id.outputEpoch.uuidString,
          "publisherIdentity": try identities.uuid(.publisher, 1).uuidString,
          "trackSid": "TR_fixture",
          "sourceAudio": ["encoding": "pcm-s16le", "sampleRateHz": 24000, "channels": 1],
        ] : NSNull(),
    ]
    return try JSONDecoder().decode(
      VoiceOutput.self, from: JSONSerialization.data(withJSONObject: wire))
  }
  func project(_ value: VoiceOutput) throws -> ITFValue {
    if let manifest = value.manifest { try validateFixtureManifest(manifest) }
    return try .record([
      "identity": project(value.identity), "status": .variant(value.status.rawValue, .unit),
      "manifest": .boolean(value.manifest != nil),
      "session": .integer(
        value.manifest.map { try identities.symbol(.session, $0.sessionId) } ?? 1),
    ])
  }
  func event(_ value: ITFValue) throws -> VoiceOutputEvent {
    let (tag, payload) = try value.variant()
    switch tag {
    case "Observe":
      let fields = try payload.record(["sequence", "output"])
      return try .observed(sequence: fields["sequence"]!.integer(), output(fields["output"]!))
    case "Accept": return try .inputAccepted(identities.uuid(.input, payload.integer()))
    case "Audio": return try .audioReceived(identity(payload))
    case "Cut":
      let fields = try payload.record(["nextInput", "pending"])
      let next = try fields["nextInput"]!.optional { try identities.uuid(.input, $0.integer()) }
      let pending = try fields["pending"]!.list().map { try identities.uuid(.input, $0.integer()) }
      return .cut(nextInput: next, pendingInputs: pending)
    case "Fail": return try .failed(identity(payload))
    case "Disconnect":
      guard payload == .unit else { throw VoiceITFError.invalid("Disconnect payload") }
      return .disconnected
    default: throw VoiceITFError.invalid("unknown output event \(tag)")
    }
  }
  func project(_ state: VoiceOutputState) throws -> ITFValue {
    try .record([
      "current": .optional(state.current, project),
      "locallyInterrupted": .boolean(state.locallyInterrupted),
      "unavailable": .boolean(state.unavailable), "receivedAudio": .boolean(state.receivedAudio),
      "closed": .boolean(state.closed), "sequence": .integer(state.sequence),
      "lastAcceptedInput": input(state.lastAcceptedInput), "cutInput": input(state.cutInput),
      "cutAcceptedInput": input(state.cutAcceptedInput),
      "cutPendingInputs": .list(
        state.cutPendingInputs.map { try .integer(identities.symbol(.input, $0)) }),
      "allowedInput": input(state.allowedInput), "gated": .boolean(state.gated),
      "prepared": .optional(state.prepared, project),
      "interrupted": .optional(state.interrupted, project),
    ])
  }
  func project(_ commands: [VoiceOutputCommand], state: VoiceOutputState) throws -> ITFValue {
    try .list(
      commands.map { command in
        switch command {
        case .prepare(let manifest):
          return try .variant("Prepare", project(manifest))
        case .suppress(let target, let stopLocal):
          return try .variant(
            "Suppress",
            .record(["target": .optional(target, project), "stopLocal": .boolean(stopLocal)]))
        }
      })
  }
  func project(_ manifest: VoiceAudioManifest) throws -> ITFValue {
    try validateFixtureManifest(manifest)
    return try .record([
      "identity": project(manifest.identity), "status": .variant("AwaitingReady", .unit),
      "manifest": .boolean(true),
      "session": .integer(identities.symbol(.session, manifest.sessionId)),
    ])
  }
  /// Fixed physical routing is an explicit fixture assumption, not an omitted
  /// command field. Reject a changed adapter contract instead of erasing it.
  private func validateFixtureManifest(_ manifest: VoiceAudioManifest) throws {
    guard manifest.isValid,
      manifest.publisherIdentity == (try identities.uuid(.publisher, 1)),
      manifest.trackSid == "TR_fixture"
    else { throw VoiceITFError.invalid("manifest outside fixed fixture routing/format") }
  }
  private func input(_ value: UUID?) throws -> ITFValue {
    try .optional(value) { try .integer(identities.symbol(.input, $0)) }
  }
}
