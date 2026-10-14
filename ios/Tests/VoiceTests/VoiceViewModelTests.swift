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

  func testTextIntentRetiresOutputBeforeLateSubscriptionCanAcknowledgeReady() async throws {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    let model = VoiceViewModel(control: control, media: media) { _ in }
    model.start()
    await settle { model.state.capture == .listening }
    let session = await control.identity()
    let response = UUID()
    let input = UUID()
    let epoch = UUID()
    let output: [String: Any] = [
      "responseId": response.uuidString, "inputDeliveryId": input.uuidString,
      "outputEpoch": epoch.uuidString, "status": "AwaitingReady", "error": NSNull(),
      "manifest": [
        "sessionId": session.uuidString, "responseId": response.uuidString,
        "inputDeliveryId": input.uuidString, "outputEpoch": epoch.uuidString,
        "publisherIdentity": UUID().uuidString, "trackSid": "TR_expected",
        "sourceAudio": ["encoding": "pcm-s16le", "sampleRateHz": 24000, "channels": 1],
      ],
    ]
    await control.append(
      try event(session: session, sequence: 1, kind: "Output", fields: ["output": output]))
    await settle { media.outputWaiting }
    model.inputIntent(UUID())
    XCTAssertGreaterThan(media.stoppedOutput, 0)
    XCTAssertTrue(model.output.locallyInterrupted)
    media.resolveOutput()
    try await Task.sleep(for: .milliseconds(300))
    let ready = await control.readyCalls()
    XCTAssertEqual(ready, 0)
    await control.append(
      try event(session: session, sequence: 2, kind: "Output", fields: ["output": output]))
    try await Task.sleep(for: .milliseconds(300))
    XCTAssertTrue(model.output.locallyInterrupted)
    media.resolveOutput()
    await model.shutdown()
  }

  func testSpeechThenEmptyUtteranceCannotResumeRetiredOutputAndEndRejectsLateOutput() async throws {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    media.holdOutput = false
    let model = VoiceViewModel(control: control, media: media) { _ in XCTFail("No input accepted") }
    model.start()
    await settle { model.state.capture == .listening }
    let session = await control.identity()
    let input = UUID()
    let response = UUID()
    let epoch = UUID()
    let value = outputValue(session: session, input: input, response: response, epoch: epoch)
    await control.append(
      try event(session: session, sequence: 1, kind: "Output", fields: ["output": value]))
    await settle { media.preparedOutputs == 1 }
    model.speechStarted()
    let utterance = UUID()
    await control.append(
      try event(
        session: session, sequence: 2, kind: "Interim",
        fields: ["utteranceId": utterance.uuidString, "text": "noise"]))
    await control.append(
      try event(
        session: session, sequence: 3, kind: "Discarded",
        fields: ["utteranceId": utterance.uuidString, "reason": "Empty"]))
    await control.append(
      try event(session: session, sequence: 4, kind: "Output", fields: ["output": value]))
    await settle { model.state.sequence == 4 }
    XCTAssertTrue(model.output.locallyInterrupted)
    XCTAssertEqual(media.preparedOutputs, 1)
    XCTAssertTrue(model.state.admissions.isEmpty)
    model.end()
    await settle { model.state.capture == .ended }
    await control.append(
      try event(
        session: session, sequence: 5, kind: "Output",
        fields: [
          "output": outputValue(session: session, input: UUID(), response: UUID(), epoch: UUID())
        ]))
    try await Task.sleep(for: .milliseconds(300))
    XCTAssertEqual(media.preparedOutputs, 1)
    await model.shutdown()
  }

  func testNewTextInputCanPlayFreshEpochWhileOldSnapshotCannotStopIt() async throws {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    media.holdOutput = false
    let model = VoiceViewModel(control: control, media: media) { _ in }
    model.start()
    await settle { model.state.capture == .listening }
    let session = await control.identity()
    let old = outputValue(session: session, input: UUID(), response: UUID(), epoch: UUID())
    await control.append(
      try event(session: session, sequence: 1, kind: "Output", fields: ["output": old]))
    await settle { media.preparedOutputs == 1 }
    let newInput = UUID()
    let response = UUID()
    let epoch = UUID()
    model.inputIntent(newInput)
    let fresh = outputValue(session: session, input: newInput, response: response, epoch: epoch)
    await control.append(
      try event(session: session, sequence: 2, kind: "Output", fields: ["output": fresh]))
    await settle { media.preparedOutputs == 2 }
    let stopped = media.stoppedOutput
    await control.append(
      try event(session: session, sequence: 3, kind: "Output", fields: ["output": old]))
    await settle { model.state.sequence == 3 }
    XCTAssertEqual(media.stoppedOutput, stopped)
    XCTAssertEqual(model.output.current?.responseId, response)
    XCTAssertFalse(model.output.locallyInterrupted)
    await model.shutdown()
  }

  func testLateReadyAndAudioCallbacksStayCutAndControlWaitsForLocalStop() async throws {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    media.holdOutput = false
    await control.holdReadiness()
    let model = VoiceViewModel(control: control, media: media) { _ in }
    model.start()
    await settle { model.state.capture == .listening }
    let session = await control.identity()
    let input = UUID()
    let response = UUID()
    let epoch = UUID()
    await control.append(
      try event(
        session: session, sequence: 1, kind: "Output",
        fields: [
          "output": outputValue(session: session, input: input, response: response, epoch: epoch)
        ]))
    for _ in 0..<100 {
      if await control.readyCalls() == 1 { break }
      try await Task.sleep(for: .milliseconds(10))
    }
    media.holdStop = true
    model.speechStarted()
    await settle { media.stopWaiting }
    let beforeStop = await control.interruptCalls()
    XCTAssertEqual(beforeStop, 0)
    media.received?(
      VoiceOutputIdentity(inputDeliveryId: input, responseId: response, outputEpoch: epoch))
    await control.resolveReady()
    try await Task.sleep(for: .milliseconds(100))
    XCTAssertTrue(model.output.locallyInterrupted)
    XCTAssertFalse(model.output.receivedAudio)
    media.resolveStop()
    for _ in 0..<100 {
      if await control.interruptCalls() == 1 { break }
      try await Task.sleep(for: .milliseconds(10))
    }
    let afterStop = await control.interruptCalls()
    XCTAssertEqual(afterStop, 1)
    await model.shutdown()
  }

  func testSpeechCutBeforeManifestDoesNotAuthorizeAnAlreadyHandedFinalWhenItsReceiptArrives()
    async throws
  {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    media.holdOutput = false
    let model = VoiceViewModel(control: control, media: media) { _ in }
    model.start()
    await settle { model.state.capture == .listening }
    let session = await control.identity()
    let oldInput = UUID()
    await control.append(
      try event(
        session: session, sequence: 1, kind: "Final",
        fields: [
          "utteranceId": oldInput.uuidString, "deliveryId": oldInput.uuidString,
          "text": "Earlier input",
        ]))
    await settle { model.state.hasPendingAdmission }
    model.speechStarted()
    await control.append(
      try event(
        session: session, sequence: 2, kind: "Accepted",
        fields: [
          "utteranceId": oldInput.uuidString,
          "receipt": [
            "deliveryId": oldInput.uuidString,
            "recordId": 8, "position": 0, "role": "user", "text": "Earlier input",
          ],
        ]))
    await control.append(
      try event(
        session: session, sequence: 3, kind: "Output",
        fields: [
          "output": outputValue(session: session, input: oldInput, response: UUID(), epoch: UUID())
        ]))
    await settle { model.state.sequence == 3 }
    XCTAssertEqual(media.preparedOutputs, 0)
    XCTAssertFalse(model.state.hasPendingAdmission)
    await model.shutdown()
  }

  func testOldMicrophoneCallbackCannotCutANewRoomOutput() async throws {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    media.holdOutput = false
    let model = VoiceViewModel(control: control, media: media) { _ in }
    model.start()
    await settle { model.state.capture == .listening }
    let oldSpeech = media.speech
    model.end()
    await settle { model.state.capture == .ended }
    model.start()
    await settle { model.state.capture == .listening }
    let session = await control.identity()
    await control.append(
      try event(
        session: session, sequence: 1, kind: "Output",
        fields: [
          "output": outputValue(session: session, input: UUID(), response: UUID(), epoch: UUID())
        ]))
    await settle { media.preparedOutputs == 1 }
    let stopped = media.stoppedOutput
    oldSpeech?()
    try await Task.sleep(for: .milliseconds(100))
    XCTAssertFalse(model.output.locallyInterrupted)
    XCTAssertEqual(media.stoppedOutput, stopped)
    await model.shutdown()
  }

  func testEveryDisconnectFencesPlayingProjectionAndPreservesPendingAdmission() async throws {
    for path in ["remote", "observation", "mute", "explicit"] {
      let control = FixtureControl()
      let media = FixtureMedia(allowed: true)
      media.holdOutput = false
      let model = VoiceViewModel(control: control, media: media) { _ in }
      model.start()
      await settle { model.state.capture == .listening }
      let session = await control.identity()
      let input = UUID()
      let response = UUID()
      let epoch = UUID()
      var value = outputValue(session: session, input: input, response: response, epoch: epoch)
      value["status"] = "Playing"
      await control.append(
        try event(session: session, sequence: 1, kind: "Output", fields: ["output": value]))
      await settle { media.preparedOutputs == 1 }
      media.received?(
        VoiceOutputIdentity(inputDeliveryId: input, responseId: response, outputEpoch: epoch))
      await settle { model.output.receivedAudio }
      let pending = UUID()
      await control.append(
        try event(
          session: session, sequence: 2, kind: "Final",
          fields: [
            "utteranceId": pending.uuidString, "deliveryId": pending.uuidString,
            "text": "Still reconciling",
          ]))
      await settle { model.state.hasPendingAdmission }
      switch path {
      case "remote":
        await control.append(try event(session: session, sequence: 3, kind: "Ended", fields: [:]))
      case "observation": await control.failSnapshots()
      case "mute":
        media.muteFailure = .capture
        model.toggleMute()
      default: model.end()
      }
      await settle { media.disconnected }
      XCTAssertNil(model.output.current, path)
      XCTAssertFalse(model.output.receivedAudio, path)
      XCTAssertTrue(model.state.hasPendingAdmission, path)
      media.received?(
        VoiceOutputIdentity(inputDeliveryId: input, responseId: response, outputEpoch: epoch))
      try await Task.sleep(for: .milliseconds(30))
      XCTAssertFalse(model.output.receivedAudio, path)
      await model.shutdown()
    }
  }

  private func outputValue(session: UUID, input: UUID, response: UUID, epoch: UUID) -> [String: Any]
  {
    [
      "responseId": response.uuidString, "inputDeliveryId": input.uuidString,
      "outputEpoch": epoch.uuidString, "status": "AwaitingReady", "error": NSNull(),
      "manifest": [
        "sessionId": session.uuidString, "responseId": response.uuidString,
        "inputDeliveryId": input.uuidString, "outputEpoch": epoch.uuidString,
        "publisherIdentity": UUID().uuidString, "trackSid": "TR_" + epoch.uuidString,
        "sourceAudio": ["encoding": "pcm-s16le", "sampleRateHz": 24000, "channels": 1],
      ],
    ]
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
  var holdStop = false
  var stopWaiting = false
  var stopContinuation: CheckedContinuation<Void, Never>?
  var received: (@Sendable (VoiceOutputIdentity) -> Void)?
  var holdOutput = true
  var preparedOutputs = 0
  var outputWaiting = false
  var stoppedOutput = 0
  var outputContinuation: CheckedContinuation<Void, Never>?
  var speech: (@Sendable () -> Void)?
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
  var muteFailure: VoiceFailure?
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
  func connect(
    _ join: VoiceJoin, failure: @escaping @Sendable () -> Void,
    speechStarted: @escaping @Sendable () -> Void,
    outputReceived: @escaping @Sendable (VoiceOutputIdentity) -> Void
  ) async throws {
    if let connectFailure { throw connectFailure }
    self.failure = failure
    self.speech = speechStarted
    self.received = outputReceived
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
    if let muteFailure { throw muteFailure }
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
  func prepareOutput(_ manifest: VoiceAudioManifest) async throws {
    preparedOutputs += 1
    outputWaiting = true
    if holdOutput { await withCheckedContinuation { outputContinuation = $0 } }
  }
  func stopOutput() -> Task<Void, Never> {
    stoppedOutput += 1
    return Task {
      if holdStop {
        stopWaiting = true
        await withCheckedContinuation { stopContinuation = $0 }
      }
    }
  }
  func resolveStop() {
    holdStop = false
    stopContinuation?.resume()
    stopContinuation = nil
  }
  func resolveOutput() {
    outputContinuation?.resume()
    outputContinuation = nil
  }
  func resolveDisconnect() {
    holdDisconnect = false
    disconnectContinuation?.resume()
    disconnectContinuation = nil
  }
}

private actor FixtureControl: VoiceControl {
  private var snapshotFailure = false
  func failSnapshots() { snapshotFailure = true }
  private var holdReady = false
  private var readyContinuation: CheckedContinuation<Void, Never>?
  private var interruptCount = 0
  func holdReadiness() { holdReady = true }
  func resolveReady() {
    holdReady = false
    readyContinuation?.resume()
    readyContinuation = nil
  }
  func interruptCalls() -> Int { interruptCount }
  private var readyCount = 0
  func readyCalls() -> Int { readyCount }
  func ready(sessionId: UUID, manifest: VoiceAudioManifest) async throws -> VoiceSnapshot {
    readyCount += 1
    if holdReady { await withCheckedContinuation { readyContinuation = $0 } }
    return try await snapshot(sessionId: sessionId, after: 0)
  }
  func interrupt(sessionId: UUID, target: VoiceOutputIdentity) async throws -> VoiceSnapshot {
    interruptCount += 1
    return try await snapshot(sessionId: sessionId, after: 0)
  }
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
        "participantIdentity": UUID().uuidString, "backendParticipantIdentity": UUID().uuidString,
        "mediaUrl": "ws://127.0.0.1:7880",
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
    if snapshotFailure { throw VoiceFailure.connection }
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
