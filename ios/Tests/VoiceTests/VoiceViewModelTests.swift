import Conversation
import XCTest

@testable import Voice

@MainActor final class VoiceViewModelTests: XCTestCase {
  func testPermissionDeniedDoesNotOpenSessionAndEndCannotReviveLatePermission() async {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: false)
    let model = VoiceViewModel(control: control, media: media) { _ in XCTFail("No receipt") }
    model.start()
    await settle { model.state.capture == .failed(.permissionDenied) }
    let count = await control.openedCount()
    XCTAssertEqual(count, 0)
    media.allowed = true
    media.holdPermission = true
    model.start()
    await settle { media.permissionWaiting }
    model.end()
    media.resolvePermission()
    await settle { model.state.capture == .ended }
    let laterCount = await control.openedCount()
    XCTAssertEqual(laterCount, 0)
  }

  func testListeningOnlyAfterPublicationAndMuteEndThroughPublicIntents() async {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    media.holdConnect = true
    let model = VoiceViewModel(control: control, media: media) { _ in }
    model.start()
    await settle { media.connectWaiting }
    XCTAssertEqual(model.state.capture, .connecting)
    media.resolveConnect()
    await settle { model.state.capture == .listening }
    model.toggleMute()
    await settle { model.state.capture == .muted }
    XCTAssertTrue(media.muted)
    model.toggleMute()
    await settle { model.state.capture == .listening }
    model.end()
    await settle { model.state.capture == .ended }
    XCTAssertTrue(media.disconnected)
    let ended = await control.wasEnded()
    XCTAssertTrue(ended)
  }

  func testFinalRemainsSeparateUntilDurableReceiptAndSettlesAfterEnd() async throws {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    var receipts: [ConversationMessage] = []
    let model = VoiceViewModel(control: control, media: media) { receipts.append($0) }
    model.start()
    await settle { model.state.capture == .listening }
    let session = await control.identity()
    let utterance = UUID()
    let delivery = utterance
    await control.append(
      try event(
        session: session, sequence: 1, kind: "Interim",
        fields: ["utteranceId": utterance.uuidString, "text": "temporary"]))
    await settle { model.state.tentative == "temporary" }
    XCTAssertTrue(receipts.isEmpty)
    await control.append(
      try event(
        session: session, sequence: 2, kind: "Final",
        fields: [
          "utteranceId": utterance.uuidString, "deliveryId": delivery.uuidString,
          "text": "final input",
        ]))
    await settle { model.state.hasPendingAdmission }
    XCTAssertEqual(model.state.admission, .saving(deliveryId: delivery, text: "final input"))
    XCTAssertTrue(receipts.isEmpty)
    model.end()
    await settle { model.state.capture == .ended }
    XCTAssertEqual(model.state.admission, .checking(deliveryId: delivery, text: "final input"))
    await control.append(
      try event(
        session: session, sequence: 3, kind: "Interim",
        fields: ["utteranceId": UUID().uuidString, "text": "late tentative"]))
    await control.append(
      try event(
        session: session, sequence: 4, kind: "Accepted",
        fields: [
          "utteranceId": utterance.uuidString,
          "receipt": [
            "deliveryId": delivery.uuidString, "recordId": 1, "position": 0, "text": "final input",
            "role": "user",
          ],
        ]))
    await settle { !receipts.isEmpty }
    XCTAssertEqual(model.state.capture, .ended)
    XCTAssertEqual(model.state.tentative, "")
    XCTAssertEqual(receipts.count, 1)
    await model.shutdown()
  }

  func testOldRoomFailureCannotStopNewGeneration() async {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    let model = VoiceViewModel(control: control, media: media) { _ in }
    model.start()
    await settle { model.state.capture == .listening }
    let oldFailure = media.failure
    model.end()
    await settle { model.state.capture == .ended }
    model.start()
    await settle { model.state.capture == .listening }
    oldFailure?()
    await Task.yield()
    XCTAssertEqual(model.state.capture, .listening)
    await model.shutdown()
  }

  func testLateFinalObservationAfterEndStillChecksAndAcceptsOnlyMatchingReceipt() async throws {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    var receipts: [ConversationMessage] = []
    let model = VoiceViewModel(control: control, media: media) { receipts.append($0) }
    model.start()
    await settle { model.state.capture == .listening }
    let session = await control.identity()
    let utterance = UUID()
    let delivery = utterance
    // A final was handed to admission before End, but polling has not seen it.
    await control.append(
      try event(
        session: session, sequence: 1, kind: "Final",
        fields: [
          "utteranceId": utterance.uuidString, "deliveryId": delivery.uuidString,
          "text": "late observed final",
        ]))
    model.end()
    await settle { model.state.capture == .ended && model.state.hasPendingAdmission }
    XCTAssertEqual(
      model.state.admission, .checking(deliveryId: delivery, text: "late observed final"))
    await control.append(
      try event(
        session: session, sequence: 2, kind: "Accepted",
        fields: [
          "utteranceId": utterance.uuidString,
          "receipt": [
            "deliveryId": UUID().uuidString, "recordId": 1, "position": 0,
            "text": "late observed final",
          ],
        ]))
    try await Task.sleep(for: .milliseconds(300))
    XCTAssertTrue(receipts.isEmpty)
    await control.append(
      try event(
        session: session, sequence: 3, kind: "Accepted",
        fields: [
          "utteranceId": utterance.uuidString,
          "receipt": [
            "deliveryId": delivery.uuidString, "recordId": 1, "position": 0,
            "text": "late observed final",
          ],
        ]))
    await settle { receipts.count == 1 }
    XCTAssertEqual(model.state.capture, .ended)
    await model.shutdown()
  }

  func testIndependentFinalsSettleWithoutOverwritingEachOther() async throws {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    var receipts: [ConversationMessage] = []
    let model = VoiceViewModel(control: control, media: media) { receipts.append($0) }
    model.start()
    await settle { model.state.capture == .listening }
    let session = await control.identity()
    let first = UUID()
    let second = UUID()
    for (sequence, id, text) in [(1, first, "first"), (2, second, "second")] {
      await control.append(
        try event(
          session: session, sequence: sequence, kind: "Final",
          fields: ["utteranceId": id.uuidString, "deliveryId": id.uuidString, "text": text]))
    }
    await settle { model.state.admissions.count == 2 }
    model.end()
    await settle { model.state.capture == .ended }
    for (sequence, id, text) in [(3, second, "second"), (4, first, "first")] {
      await control.append(
        try event(
          session: session, sequence: sequence, kind: "Accepted",
          fields: [
            "utteranceId": id.uuidString,
            "receipt": [
              "deliveryId": id.uuidString, "recordId": sequence, "position": sequence, "text": text,
            ],
          ]))
    }
    await settle { receipts.count == 2 }
    XCTAssertEqual(Set(receipts.map(\.deliveryId)), Set([first, second]))
    XCTAssertFalse(model.state.hasPendingAdmission)
    await model.shutdown()
  }

  func testCaptureFailureLeavesRecoverableFailureAndDisconnects() async {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    media.connectFailure = .capture
    let model = VoiceViewModel(control: control, media: media) { _ in }
    model.start()
    await settle { model.state.capture == .failed(.capture) }
    XCTAssertTrue(model.state.canStart)
    XCTAssertTrue(media.disconnected)
    await model.shutdown()
  }

  func testCanonicalReceiptRecoversFinalAcceptanceBeyondEventRing() async throws {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    var receipts: [ConversationMessage] = []
    let model = VoiceViewModel(control: control, media: media) { receipts.append($0) }
    model.start()
    await settle { model.state.capture == .listening }
    let id = UUID()
    let session = await control.identity()
    let receipt = ConversationMessage(
      deliveryId: id, recordId: 50, position: 30, text: "Recovered saved speech")
    let pending = VoicePending(
      utteranceId: id, deliveryId: id, text: receipt.text, receipt: receipt, error: nil)
    await control.installRecovery(
      pending, event: try event(session: session, sequence: 100, kind: "Ended", fields: [:]))
    await settle { receipts.count == 1 && model.state.capture == .ended }
    XCTAssertEqual(receipts, [receipt])
    XCTAssertFalse(model.state.hasPendingAdmission)
    XCTAssertEqual(model.state.tentative, "")
    await model.shutdown()
  }

  func testDelayedMuteThenEndThenStartCanMuteNewSession() async {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    let model = VoiceViewModel(control: control, media: media) { _ in }
    model.start()
    await settle { model.state.capture == .listening }
    media.holdMute = true
    model.toggleMute()
    await settle { media.muteWaiting }
    model.end()
    await settle { model.state.capture == .ended }
    model.start()
    await settle { model.state.capture == .listening }
    media.resolveMute()
    await Task.yield()
    model.toggleMute()
    await settle { model.state.capture == .muted }
    await model.shutdown()
  }

  func testDiscardedEmptyUtteranceClearsOnlyItsTentativeAndSavesNothing() async throws {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    var receipts: [ConversationMessage] = []
    let model = VoiceViewModel(control: control, media: media) { receipts.append($0) }
    model.start()
    await settle { model.state.capture == .listening }
    let session = await control.identity()
    let old = UUID()
    let current = UUID()
    await control.append(
      try event(
        session: session, sequence: 1, kind: "Interim",
        fields: ["utteranceId": current.uuidString, "text": "tentative noise"]))
    await settle { !model.state.tentative.isEmpty }
    await control.append(
      try event(
        session: session, sequence: 2, kind: "Discarded",
        fields: ["utteranceId": old.uuidString, "reason": "Empty"]))
    try await Task.sleep(for: .milliseconds(300))
    XCTAssertEqual(model.state.tentative, "tentative noise")
    await control.append(
      try event(
        session: session, sequence: 3, kind: "Discarded",
        fields: ["utteranceId": current.uuidString, "reason": "Empty"]))
    await settle { model.state.tentative.isEmpty }
    XCTAssertTrue(receipts.isEmpty)
    XCTAssertTrue(model.state.admissions.isEmpty)
    await model.shutdown()
  }

  func testEndCancelsRemoteRecognitionBeforeSlowLocalRoomDisconnectFinishes() async {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    let model = VoiceViewModel(control: control, media: media) { _ in }
    model.start()
    await settle { model.state.capture == .listening }
    media.holdDisconnect = true
    model.end()
    await settle { media.disconnectWaiting }
    var remoteEnded = false
    for _ in 0..<100 {
      remoteEnded = await control.wasEnded()
      if remoteEnded { break }
      await Task.yield()
    }
    XCTAssertTrue(remoteEnded)
    XCTAssertEqual(model.state.capture, .ending)
    media.resolveDisconnect()
    await settle { model.state.capture == .ended }
    await model.shutdown()
  }

  func testEndDuringConnectingClosesBootstrapAndFencesLateMicrophonePublication() async {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    media.holdConnect = true
    let model = VoiceViewModel(control: control, media: media) { _ in }
    model.start()
    await settle { media.connectWaiting }
    model.end()
    await settle { model.state.capture == .ended }
    let ended = await control.wasEnded()
    XCTAssertTrue(ended)
    model.start()
    let countBeforeDrain = await control.openedCount()
    XCTAssertEqual(countBeforeDrain, 1)
    media.holdConnect = false
    media.resolveConnect()
    await settle { model.state.capture == .listening }
    let countAfterDrain = await control.openedCount()
    XCTAssertEqual(countAfterDrain, 2)
    await model.shutdown()
  }

  private func settle(_ predicate: () -> Bool) async {
    for _ in 0..<300 {
      if predicate() { return }
      try? await Task.sleep(for: .milliseconds(10))
    }
    XCTFail("State did not settle")
  }
  private func event(session: UUID, sequence: Int, kind: String, fields: [String: Any]) throws
    -> VoiceWireEvent
  {
    var value = fields
    value["sessionId"] = session.uuidString
    value["sequence"] = sequence
    value["kind"] = kind
    return try JSONDecoder().decode(
      VoiceWireEvent.self, from: JSONSerialization.data(withJSONObject: value))
  }
}

@MainActor private final class FixtureMedia: VoiceMedia {
  var allowed: Bool
  var holdPermission = false
  var permissionWaiting = false
  var holdDisconnect = false
  var disconnectWaiting = false
  var holdMute = false
  var muteWaiting = false
  var holdConnect = false
  var connectWaiting = false
  var muted = false
  var disconnected = false
  var connectFailure: VoiceFailure?
  var failure: (@Sendable () -> Void)?
  private var permission: CheckedContinuation<Bool, Never>?
  private var disconnectContinuation: CheckedContinuation<Void, Never>?
  private var muteContinuation: CheckedContinuation<Void, Never>?
  private var publication: CheckedContinuation<Void, Never>?
  init(allowed: Bool) { self.allowed = allowed }
  func requestPermission() async -> Bool {
    if !holdPermission { return allowed }
    permissionWaiting = true
    return await withCheckedContinuation { permission = $0 }
  }
  func resolvePermission() {
    permission?.resume(returning: allowed)
    permission = nil
  }
  func connect(_ join: VoiceJoin, failure: @escaping @Sendable () -> Void) async throws {
    if let connectFailure { throw connectFailure }
    self.failure = failure
    disconnected = false
    if holdConnect {
      connectWaiting = true
      await withCheckedContinuation { publication = $0 }
    }
  }
  func resolveConnect() {
    publication?.resume()
    publication = nil
  }
  func mute(_ muted: Bool) async throws {
    if holdMute {
      muteWaiting = true
      await withCheckedContinuation { muteContinuation = $0 }
    }
    self.muted = muted
  }
  func resolveMute() {
    holdMute = false
    muteContinuation?.resume()
    muteContinuation = nil
  }
  func disconnect() async {
    disconnected = true
    if holdDisconnect {
      disconnectWaiting = true
      await withCheckedContinuation { disconnectContinuation = $0 }
    }
  }
  func resolveDisconnect() {
    holdDisconnect = false
    disconnectContinuation?.resume()
    disconnectContinuation = nil
  }
}

private actor FixtureControl: VoiceControl {
  private var session = UUID()
  private var opened = 0
  private var ended = false
  private var events: [VoiceWireEvent] = []
  private var pending: [VoicePending] = []
  func start() async throws -> VoiceJoin {
    opened += 1
    ended = false
    session = UUID()
    events = []
    return try JSONDecoder().decode(
      VoiceJoin.self,
      from: JSONSerialization.data(withJSONObject: [
        "sessionId": session.uuidString, "roomName": session.uuidString,
        "participantIdentity": UUID().uuidString, "mediaUrl": "ws://127.0.0.1:7880",
        "token": "fixture", "controlToken": String(repeating: "a", count: 64),
        "expiresAt": 9_999_999_999_999,
      ]))
  }
  func identity() -> UUID { session }
  func openedCount() -> Int { opened }
  func wasEnded() -> Bool { ended }
  func append(_ event: VoiceWireEvent) { events.append(event) }
  func installRecovery(_ value: VoicePending, event: VoiceWireEvent) {
    pending = [value]
    events = [event]
    ended = true
  }
  func snapshot(sessionId: UUID, after: Int) async throws -> VoiceSnapshot {
    let payload =
      "{\"sessionId\":\"\(session.uuidString)\",\"status\":\"\(ended ? "ended" : "active")\",\"muted\":false,\"sequence\":\(events.last?.sequence ?? 0),\"events\":[],\"nextAfter\":null,\"firstSequence\":1,\"audioFramesReceived\":0,\"sampleFramesReceived\":0,\"pending\":[]}"
    let empty = try JSONDecoder().decode(VoiceSnapshot.self, from: Data(payload.utf8))
    return VoiceSnapshot(
      sessionId: empty.sessionId, status: empty.status, muted: false, sequence: empty.sequence,
      events: events.filter { $0.sequence > after }, nextAfter: nil,
      firstSequence: events.first?.sequence, pending: pending)
  }
  func mute(sessionId: UUID, muted: Bool) async throws {}
  func end(sessionId: UUID) async throws { ended = true }
}
