import XCTest

@testable import Voice

final class VoiceLifecycleITFBoundaryTests: XCTestCase {
  func testInitialOwnerIsReachedThroughRealFeatureTransitions() throws {
    let mapping = VoiceLifecycleITFMapping()
    let state = try mapping.initial()
    XCTAssertEqual(state.capture, .listening)
    XCTAssertEqual(state.generation, 1)
    XCTAssertEqual(state.execution.nextRequest, 8)
    XCTAssertEqual(state.execution.operations.count, 1)
    XCTAssertEqual(
      state.execution.operations[.init(generation: 1, id: 6)]?.kind,
      .snapshot(try mapping.origin(1), 0))
    XCTAssertEqual(state.execution.platformObservation, .init(generation: 1, id: 1))
    XCTAssertEqual(state.execution.activeCapture, .init(generation: 1, id: 5))
  }
  func testConnectCommandRejectsWrongProposalAndUnexpectedWireFields() throws {
    let mapping = VoiceLifecycleITFMapping()
    let state = try mapping.initial()
    let origin = try mapping.origin(1)
    let correct = try mapping.join(
      origin: origin, proposal: mapping.output.identities.uuid(.proposal, 1))
    let wrong = try mapping.join(
      origin: origin, proposal: mapping.output.identities.uuid(.proposal, 2))
    let request = VoiceRequest(generation: 1, id: 8)
    XCTAssertNoThrow(
      try mapping.commands(
        [.run(request, .connect(correct, muted: false), after: [])], state: state))
    XCTAssertThrowsError(
      try mapping.commands([.run(request, .connect(wrong, muted: false), after: [])], state: state))
    var wire = try XCTUnwrap(
      JSONSerialization.jsonObject(with: JSONEncoder().encode(correct)) as? [String: Any])
    wire["mediaUrl"] = "wss://other.invalid"
    let rerouted = try JSONDecoder().decode(
      VoiceJoin.self, from: JSONSerialization.data(withJSONObject: wire))
    XCTAssertThrowsError(
      try mapping.commands(
        [.run(request, .connect(rerouted, muted: false), after: [])], state: state))
  }

  func testLifecycleBoundaryRejectsUnknownEventsAndInvalidRequestIdentity() throws {
    let mapping = VoiceLifecycleITFMapping()
    let state = try mapping.initial()
    XCTAssertThrowsError(try mapping.input(.variant("Unknown", .unit), state: state))
    XCTAssertThrowsError(try mapping.input(.variant("Mute", .boolean(true)), state: state))
    XCTAssertThrowsError(
      try mapping.request(.record(["generation": .integer(1), "id": .integer(0)])))
    XCTAssertThrowsError(
      try mapping.request(.record(["generation": .integer(0), "id": .integer(1)])))
  }

  func testReconnectedOwnerCanPrepareFreshOutputAfterRejectingOldOrigin() throws {
    let mapping = VoiceLifecycleITFMapping()
    let files = try VoiceITFCorpus.files(prefix: "lifecycle-")
    let url = try XCTUnwrap(
      files.first { $0.lastPathComponent.contains("recoveryRejectsOldOriginTest-") })
    let trace = try JSONDecoder().decode(VoiceITFDocument.self, from: Data(contentsOf: url))
    var state = try mapping.initial()
    for frame in trace.states {
      guard let event = try frame.values["event"]?.optional({ $0 }) else { continue }
      state = try transitionVoice(state, mapping.input(event, state: state)).state
    }
    let expected = try VoiceOutputIdentity(
      inputDeliveryId: mapping.output.identities.uuid(.input, 2),
      responseId: mapping.output.identities.uuid(.response, 2),
      outputEpoch: mapping.output.identities.uuid(.epoch, 1))
    XCTAssertEqual(state.capture, .listening)
    XCTAssertFalse(state.output.closed)
    XCTAssertEqual(state.output.current?.identity, expected)
    XCTAssertEqual(state.output.prepared, expected)
  }

  func testMismatchedBootstrapProposalFailsAndRetainsExactAcquiredOriginForCleanup() throws {
    let mapping = VoiceLifecycleITFMapping()
    let proposal = try mapping.output.identities.uuid(.proposal, 1)
    let prefix: [VoiceFeatureEvent] = [
      .start,
      .completed(.init(generation: 1, id: 1), .platformObserved),
      .completed(.init(generation: 1, id: 2), .restored(.success([]))),
      .completed(.init(generation: 1, id: 3), .permission(true)),
    ]
    let pending = prefix.reduce(VoiceState()) { state, event in
      transitionVoice(state, VoiceInput(event: event, proposedStartRequestId: proposal)).state
    }
    let acquired = try mapping.origin(2)
    let wrongJoin = try mapping.join(
      origin: acquired, proposal: mapping.output.identities.uuid(.proposal, 2))
    let step = transitionVoice(
      pending,
      VoiceInput(
        event: .completed(.init(generation: 1, id: 4), .bootstrapped(.success(wrongJoin))),
        proposedStartRequestId: proposal))
    XCTAssertEqual(step.state.capture, .failed(.invalidResponse))
    XCTAssertEqual(step.state.execution.bootstrapReleases[acquired]?.origin, acquired)
    XCTAssertNil(step.state.origin)
    XCTAssertFalse(
      step.commands.contains { command in
        if case .run(_, .connect, _) = command { return true }
        return false
      })
    let releases = step.commands.compactMap { command -> VoiceOrigin? in
      if case .run(_, .endBootstrap(let origin), _) = command { return origin }
      return nil
    }
    XCTAssertEqual(releases, [acquired])
  }

}
