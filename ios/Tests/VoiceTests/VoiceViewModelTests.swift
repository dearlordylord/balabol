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
    await settle { model.state.admission == .saving(deliveryId: delivery, text: "final input") }
    XCTAssertTrue(model.state.hasPendingAdmission)
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
      utteranceId: id,
      backendIncarnationId: UUID(uuidString: "11111111-1111-4111-8111-111111111111")!,
      deliveryId: id, text: receipt.text, receipt: receipt, error: nil)
    await control.installRecovery(
      pending, event: try event(session: session, sequence: 100, kind: "Ended", fields: [:]))
    await settle { receipts.count == 1 && model.state.capture == .hostUnavailable }
    XCTAssertEqual(receipts, [receipt])
    await settle { model.state.capture == .listening }
    let freshSession = await control.identity()
    XCTAssertNotEqual(freshSession, session)
    XCTAssertEqual(receipts, [receipt])
    XCTAssertEqual(media.preparedOutputs, 0)
    XCTAssertNil(model.output.current)
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
    let checkpoint = GatedVoiceCheckpoint()
    let model = VoiceViewModel(control: control, media: media, checkpoint: checkpoint) { _ in }
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
    await checkpoint.waitForSave()
    XCTAssertTrue(model.state.hasPendingAdmission)
    XCTAssertNil(model.state.admission)
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
    await checkpoint.release()
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

  func testUncertainBootstrapKeepsIdentityAcrossBoundedBackoffAndEndCancelsRetry() async throws {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    let clock = FixtureRetryClock()
    await control.failStarts(6)
    let model = VoiceViewModel(control: control, media: media, retryClock: clock) { _ in }
    model.start()
    for expected in [500, 1000, 2000, 4000, 8000] {
      for _ in 0..<200 {
        if await clock.lastDelay() == expected { break }
        try await Task.sleep(for: .milliseconds(5))
      }
      let delay = await clock.lastDelay()
      XCTAssertEqual(delay, expected)
      if expected != 8000 { await clock.advance() }
    }
    let requests = await control.requestIdentities()
    XCTAssertEqual(requests.count, 5)
    XCTAssertEqual(Set(requests).count, 1)
    XCTAssertEqual(model.state.capture, .hostUnavailable)
    model.end()
    await settle { model.state.capture == .ended }
    await clock.advance()
    try await Task.sleep(for: .milliseconds(30))
    let later = await control.requestIdentities()
    XCTAssertEqual(later, requests)
    await model.shutdown()
  }

  func testFinalWaitsForPrivateCheckpointAndUnknownSurvivesEndAndClientRestart() async throws {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    let checkpoint = GatedVoiceCheckpoint()
    let model = VoiceViewModel(control: control, media: media, checkpoint: checkpoint) { _ in }
    model.start()
    await settle { model.state.capture == .listening }
    let session = await control.identity()
    let delivery = UUID()
    await control.append(
      try event(
        session: session, sequence: 1, kind: "Final",
        fields: [
          "utteranceId": delivery.uuidString, "deliveryId": delivery.uuidString,
          "text": "Handed final",
        ]))
    for _ in 0..<200 {
      if await checkpoint.isSaving() { break }
      try await Task.sleep(for: .milliseconds(5))
    }
    let saving = await checkpoint.isSaving()
    XCTAssertTrue(saving)
    guard saving else {
      await model.shutdown()
      return
    }
    XCTAssertNil(model.state.admission)
    model.end()
    await settle { model.state.capture == .ended }
    await checkpoint.release()
    await settle { model.state.admission == .checking(deliveryId: delivery, text: "Handed final") }
    await model.shutdown()
    let saved = try await checkpoint.load()
    XCTAssertEqual(saved.map(\.deliveryId), [delivery])
    XCTAssertEqual(saved.map(\.sessionId), [session])
    var receipts: [ConversationMessage] = []
    let restartedMedia = FixtureMedia(allowed: true)
    let restarted = VoiceViewModel(control: control, media: restartedMedia, checkpoint: checkpoint)
    { receipts.append($0) }
    await restarted.restore()
    XCTAssertEqual(restarted.state.capture, .idle)
    XCTAssertTrue(restarted.state.hasPendingAdmission)
    XCTAssertTrue(receipts.isEmpty)
    let receipt = ConversationMessage(
      deliveryId: delivery, recordId: 12, position: 4, text: "Handed final")
    await control.acceptAdmission(receipt)
    await settle { receipts == [receipt] }
    XCTAssertFalse(restarted.state.hasPendingAdmission)
    let cleaned = try await checkpoint.load()
    XCTAssertTrue(cleaned.isEmpty)
    await restarted.shutdown()
  }

  func testMutedReconnectUsesFreshIdentityAndVoiceBusyRetriesUntilLeaseClears() async throws {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    let clock = FixtureRetryClock()
    let model = VoiceViewModel(control: control, media: media, retryClock: clock) { _ in
      XCTFail("No admission")
    }
    model.start()
    await settle { model.state.capture == .listening }
    let initial = await control.requestIdentities()
    model.toggleMute()
    await settle { model.state.capture == .muted }
    let oldFailure = media.failure
    await control.holdVoiceBusy(1)
    oldFailure?()
    await settle { model.state.capture == .hostUnavailable }
    await clock.advance()
    for _ in 0..<200 {
      if await control.requestIdentities().count == 2 { break }
      try await Task.sleep(for: .milliseconds(5))
    }
    XCTAssertTrue(model.state.wantsMuted)
    XCTAssertTrue(model.state.wantsListening)
    await clock.advance()
    await settle { model.state.capture == .muted }
    let requests = await control.requestIdentities()
    let muteRequests = await control.muteRequests()
    XCTAssertEqual(requests.count, 3)
    XCTAssertNotEqual(requests[1], initial[0])
    XCTAssertEqual(requests[1], requests[2])
    XCTAssertEqual(muteRequests, [false, true, true])
    XCTAssertTrue(media.muted)
    oldFailure?()
    try await Task.sleep(for: .milliseconds(30))
    XCTAssertEqual(model.state.capture, .muted)
    XCTAssertNil(model.output.current)
    await model.shutdown()
  }

  func testShutdownRejectsLateSnapshotAndWaitsForItsProducer() async throws {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    let checkpoint = VolatileVoiceAdmissionCheckpoint()
    var receipts: [ConversationMessage] = []
    let model = VoiceViewModel(control: control, media: media, checkpoint: checkpoint) {
      receipts.append($0)
    }
    model.start()
    await settle { model.state.capture == .listening }
    await control.holdSnapshots()
    for _ in 0..<300 {
      if await control.snapshotWaiting() { break }
      try await Task.sleep(for: .milliseconds(5))
    }
    let waiting = await control.snapshotWaiting()
    XCTAssertTrue(waiting)
    let session = await control.identity()
    let delivery = UUID()
    await control.append(
      try event(
        session: session, sequence: 1, kind: "Final",
        fields: [
          "utteranceId": delivery.uuidString, "deliveryId": delivery.uuidString,
          "text": "Late final",
        ]))
    var finished = false
    let shutdown = Task {
      await model.shutdown()
      finished = true
    }
    await settle { media.disconnected }
    XCTAssertFalse(finished)
    await control.releaseSnapshot()
    await shutdown.value
    XCTAssertTrue(finished)
    XCTAssertNil(model.state.admission)
    XCTAssertTrue(receipts.isEmpty)
    let persisted = try await checkpoint.load()
    XCTAssertTrue(persisted.isEmpty)
    model.start()
    XCTAssertFalse(model.state.wantsListening)
  }

  func testShutdownRejectsLateResolutionWithoutDeletingUncertainProvenance() async throws {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    let checkpoint = VolatileVoiceAdmissionCheckpoint()
    let association = VoiceAdmissionAssociation(
      backendIncarnationId: UUID(), sessionId: UUID(), deliveryId: UUID())
    try await checkpoint.save([association])
    await control.acceptAdmission(
      ConversationMessage(
        deliveryId: association.deliveryId, recordId: 91, position: 91, text: "Accepted later"))
    await control.holdResolutions()
    var receipts: [ConversationMessage] = []
    let model = VoiceViewModel(control: control, media: media, checkpoint: checkpoint) {
      receipts.append($0)
    }
    await model.restore()
    for _ in 0..<300 {
      if await control.resolutionWaiting() { break }
      try await Task.sleep(for: .milliseconds(5))
    }
    let waiting = await control.resolutionWaiting()
    XCTAssertTrue(waiting)
    var finished = false
    let shutdown = Task {
      await model.shutdown()
      finished = true
    }
    await settle { model.state.isRetired }
    XCTAssertFalse(finished)
    await control.releaseResolution()
    await shutdown.value
    XCTAssertTrue(receipts.isEmpty)
    XCTAssertTrue(model.state.hasPendingAdmission)
    let persisted = try await checkpoint.load()
    XCTAssertEqual(persisted, [association])
  }

  func testShutdownDrainsFinalCheckpointAndAlreadyQueuedReceiptCleanup() async throws {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    let checkpoint = GatedVoiceCheckpoint()
    var receipts: [ConversationMessage] = []
    let model = VoiceViewModel(control: control, media: media, checkpoint: checkpoint) {
      receipts.append($0)
    }
    model.start()
    await settle { model.state.capture == .listening }
    let session = await control.identity()
    let delivery = UUID()
    await control.append(
      try event(
        session: session, sequence: 1, kind: "Final",
        fields: [
          "utteranceId": delivery.uuidString, "deliveryId": delivery.uuidString, "text": "Final",
        ]))
    await checkpoint.waitForSave()
    let receipt = ConversationMessage(
      deliveryId: delivery, recordId: 92, position: 92, text: "Final")
    let receiptJSON = try JSONSerialization.jsonObject(with: JSONEncoder().encode(receipt))
    await control.append(
      try event(
        session: session, sequence: 2, kind: "Accepted",
        fields: [
          "utteranceId": delivery.uuidString, "receipt": receiptJSON,
        ]))
    await settle { receipts == [receipt] }
    var finished = false
    let shutdown = Task {
      await model.shutdown()
      finished = true
    }
    await settle { media.disconnected }
    XCTAssertFalse(finished)
    await checkpoint.release()
    await shutdown.value
    let persisted = try await checkpoint.load()
    XCTAssertTrue(persisted.isEmpty)
    XCTAssertEqual(receipts, [receipt])
    XCTAssertTrue(finished)
  }

  func testAdmissionSettledDuringBootstrapStillJoinsMutedThenUnmutesBothOwners() async throws {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    let checkpoint = VolatileVoiceAdmissionCheckpoint()
    let association = VoiceAdmissionAssociation(
      backendIncarnationId: UUID(), sessionId: UUID(), deliveryId: UUID())
    try await checkpoint.save([association])
    await control.holdBootstrap()
    var receipts: [ConversationMessage] = []
    let model = VoiceViewModel(control: control, media: media, checkpoint: checkpoint) {
      receipts.append($0)
    }
    model.start()
    for _ in 0..<300 {
      if await control.bootstrapWaiting() { break }
      try await Task.sleep(for: .milliseconds(5))
    }
    let waiting = await control.bootstrapWaiting()
    XCTAssertTrue(waiting)
    let initialMute = await control.muteRequests()
    XCTAssertEqual(initialMute, [true])
    let receipt = ConversationMessage(
      deliveryId: association.deliveryId,
      recordId: 97, position: 97, text: "Prior speech")
    await control.acceptAdmission(receipt)
    await settle { receipts == [receipt] && !model.state.hasPendingAdmission }
    await control.releaseBootstrap()
    await settle { model.state.capture == .listening }
    XCTAssertEqual(media.joinMutes, [true])
    let controlMutes = await control.controlMuteRequests()
    XCTAssertEqual(controlMutes, [false])
    XCTAssertFalse(media.muted)
    XCTAssertFalse(model.state.wantsMuted)
    await model.shutdown()
  }

  func testMuteIntentDuringBootstrapReconcilesImmutableBackendModeAndLocalCapture() async throws {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    await control.holdBootstrap()
    let model = VoiceViewModel(control: control, media: media) { _ in }
    model.start()
    for _ in 0..<300 {
      if await control.bootstrapWaiting() { break }
      try await Task.sleep(for: .milliseconds(5))
    }
    let waiting = await control.bootstrapWaiting()
    XCTAssertTrue(waiting)
    model.toggleMute()
    XCTAssertTrue(model.state.wantsMuted)
    await control.releaseBootstrap()
    await settle { model.state.capture == .muted && !model.state.isChangingMute }
    let requestModes = await control.muteRequests()
    XCTAssertEqual(requestModes, [false])
    XCTAssertEqual(media.joinMutes, [true])
    let controlModes = await control.controlMuteRequests()
    XCTAssertEqual(controlModes, [true])
    XCTAssertTrue(media.muted)
    await model.shutdown()
  }

  func testUnknownPreviousSpeechKeepsReconnectMutedUntilExactNotAcceptedResolution() async throws {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    let checkpoint = VolatileVoiceAdmissionCheckpoint()
    let association = VoiceAdmissionAssociation(
      backendIncarnationId: UUID(), sessionId: UUID(), deliveryId: UUID())
    try await checkpoint.save([association])
    var receipts: [ConversationMessage] = []
    let model = VoiceViewModel(control: control, media: media, checkpoint: checkpoint) {
      receipts.append($0)
    }
    model.start()
    await settle { model.state.capture == .checkingPreviousSpeech }
    XCTAssertTrue(model.state.wantsListening)
    XCTAssertFalse(model.state.wantsMuted)
    XCTAssertTrue(media.muted)
    XCTAssertEqual(media.joinMutes, [true])
    XCTAssertEqual(model.state.admission, .checking(deliveryId: association.deliveryId, text: ""))
    let before = try await checkpoint.load()
    XCTAssertEqual(before, [association])
    await control.rejectAdmission(association.deliveryId)
    await settle { model.state.capture == .listening && !model.state.hasPendingAdmission }
    if case .failed(_, .backend(let code, _)) = model.state.admission {
      XCTAssertEqual(code, "NotAccepted")
    } else {
      XCTFail("Only exact NotAccepted may ask for repetition")
    }
    XCTAssertTrue(receipts.isEmpty)
    XCTAssertFalse(media.muted)
    await model.shutdown()
    let after = try await checkpoint.load()
    XCTAssertTrue(after.isEmpty)
  }

  func testEndedCanonicalSnapshotReconnectsEvenWhenEndedEventWasEvicted() async throws {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    let clock = FixtureRetryClock()
    let model = VoiceViewModel(control: control, media: media, retryClock: clock) { _ in }
    model.start()
    await settle { model.state.capture == .listening }
    let oldSession = await control.identity()
    try await control.end(sessionId: oldSession)
    await settle { model.state.capture == .hostUnavailable }
    XCTAssertTrue(model.state.wantsListening)
    XCTAssertNil(model.output.current)
    await clock.advance()
    await settle { model.state.capture == .listening }
    let newSession = await control.identity()
    XCTAssertNotEqual(newSession, oldSession)
    XCTAssertEqual(media.preparedOutputs, 0)
    await model.shutdown()
  }

  func testUnreadableCheckpointPreventsCaptureAndExplicitRetryReloadsRepairedFile() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let origin = try XCTUnwrap(URL(string: "http://127.0.0.1:8788"))
    let file = try FileVoiceAdmissionCheckpoint.fileURL(in: directory, controlOrigin: origin)
    try Data("Invalid checkpoint".utf8).write(to: file)
    let checkpoint = try FileVoiceAdmissionCheckpoint(url: file, controlOrigin: origin)
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    let model = VoiceViewModel(control: control, media: media, checkpoint: checkpoint) { _ in }
    await model.restore()
    XCTAssertEqual(model.state.capture, .failed(.checkpointUnavailable))
    model.start()
    await settle { model.state.capture == .failed(.checkpointUnavailable) }
    let unopened = await control.openedCount()
    XCTAssertEqual(unopened, 0)
    XCTAssertTrue(media.joinMutes.isEmpty)
    try await checkpoint.save([])
    model.start()
    await settle { model.state.capture == .listening }
    XCTAssertEqual(media.joinMutes, [false])
    await model.shutdown()
  }

  func testCapabilityFailureDoesNotStopCaptureOrInventConfiguredLanguages() async throws {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    let model = VoiceViewModel(control: control, media: media) { _ in }
    model.start()
    await settle { model.state.capture == .listening && model.state.languages != nil }
    XCTAssertEqual(model.state.languages?.allowedLanguages, ["ru", "fr", "en"])
    await control.failLanguages()
    await model.loadLanguages()
    XCTAssertEqual(model.state.capture, .listening)
    XCTAssertTrue(model.state.wantsListening)
    XCTAssertEqual(
      model.state.languageFailure,
      .backend(code: "InvalidLanguageConfiguration", message: "ja is unsupported by synthesis"))
    XCTAssertNil(model.state.languages)
    await model.shutdown()
  }

  func testFinalAndAcceptedMixedLanguageAnnotationsRemainSeparateFromSaveStatus() async throws {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    var receipts: [ConversationMessage] = []
    let model = VoiceViewModel(control: control, media: media) { receipts.append($0) }
    model.start()
    await settle { model.state.capture == .listening }
    let session = await control.identity()
    let delivery = UUID()
    let spans = [
      LanguageSpan(language: "fr", start: 0, end: 7),
      LanguageSpan(language: "en", start: 8, end: 13),
    ]
    await control.append(
      try event(
        session: session, sequence: 1, kind: "Final",
        fields: [
          "utteranceId": delivery.uuidString, "deliveryId": delivery.uuidString,
          "text": "Bonjour Hello",
          "languageSpans": try JSONSerialization.jsonObject(with: JSONEncoder().encode(spans)),
        ]))
    await settle { model.state.admission == .saving(deliveryId: delivery, text: "Bonjour Hello") }
    XCTAssertEqual(model.state.admissionLanguageSpans[delivery], spans)
    XCTAssertTrue(receipts.isEmpty)
    let receipt = ConversationMessage(
      deliveryId: delivery, recordId: 121, position: 121,
      text: "Bonjour Hello", languageSpans: spans)
    await control.append(
      try event(
        session: session, sequence: 2, kind: "Accepted",
        fields: [
          "utteranceId": delivery.uuidString,
          "receipt": try JSONSerialization.jsonObject(with: JSONEncoder().encode(receipt)),
        ]))
    await settle { model.state.admission == .saved(receipt) }
    XCTAssertEqual(receipts, [receipt])
    XCTAssertEqual(model.state.admissionLanguageSpans[delivery], spans)
    XCTAssertEqual(model.state.capture, .listening)
    let rooms = await control.openedCount()
    XCTAssertEqual(rooms, 1)
    await model.shutdown()
  }

  func testDirectAcceptedSnapshotsBoundSettledProjectionAndPreserveUnresolvedSpeech() async throws {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    var receipts: [ConversationMessage] = []
    let model = VoiceViewModel(control: control, media: media) { receipts.append($0) }
    model.start()
    await settle { model.state.capture == .listening }
    let incarnation = try XCTUnwrap(UUID(uuidString: "11111111-1111-4111-8111-111111111111"))
    let unresolved = UUID()
    let pending = VoicePending(
      utteranceId: unresolved, backendIncarnationId: incarnation,
      deliveryId: unresolved, text: "Unresolved speech", receipt: nil, error: nil)
    var expected: [ConversationMessage] = []
    for position in 1...4 {
      let spans = [LanguageSpan(language: "en", start: 0, end: 5)]
      let receipt = ConversationMessage(
        deliveryId: UUID(), recordId: position, position: position,
        text: "Hello", languageSpans: spans)
      expected.append(receipt)
      await control.installPending([
        pending,
        VoicePending(
          utteranceId: receipt.deliveryId, backendIncarnationId: incarnation,
          deliveryId: receipt.deliveryId, text: receipt.text, receipt: receipt, error: nil,
          languageSpans: spans),
      ])
      await settle { receipts.count == position && model.state.admissions[unresolved] != nil }
      XCTAssertEqual(receipts, expected)
      XCTAssertEqual(Set(model.state.utterances), [unresolved, receipt.deliveryId])
      XCTAssertEqual(Set(model.state.admissions.keys), [unresolved, receipt.deliveryId])
      XCTAssertEqual(
        Set(model.state.admissionLanguageSpans.keys), [unresolved, receipt.deliveryId])
      XCTAssertTrue(model.state.hasPendingAdmission)
      XCTAssertLessThanOrEqual(model.state.recentAcceptedAdmissions.count, 2)
    }
    let session = await control.identity()
    let old = expected[0]
    await control.replaySnapshot(
      VoiceSnapshot(
        sessionId: session, status: "active", muted: false,
        sequence: 1, backendIncarnationId: incarnation, events: [], nextAfter: nil,
        pending: [
          VoicePending(
            utteranceId: old.deliveryId, backendIncarnationId: incarnation,
            deliveryId: old.deliveryId, text: old.text, receipt: old, error: nil,
            languageSpans: old.languageSpans)
        ]))
    try await Task.sleep(for: .milliseconds(600))
    XCTAssertEqual(receipts, expected)
    XCTAssertEqual(Set(model.state.utterances), [unresolved, expected[3].deliveryId])
    XCTAssertLessThanOrEqual(model.state.recentAcceptedAdmissions.count, 2)
    await model.shutdown()
  }

  func testRepeatedTwoAcceptedCanonicalReceiptsCallConversationOnceAndKeepOneSettledRow()
    async throws
  {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    var receipts: [ConversationMessage] = []
    let model = VoiceViewModel(control: control, media: media) { receipts.append($0) }
    model.start()
    await settle { model.state.capture == .listening }
    let incarnation = try XCTUnwrap(UUID(uuidString: "11111111-1111-4111-8111-111111111111"))
    let expected = (1...2).map { position in
      ConversationMessage(
        deliveryId: UUID(), recordId: position, position: position, text: "Hello",
        languageSpans: [LanguageSpan(language: "en", start: 0, end: 5)])
    }
    await control.installPending(
      expected.map { receipt in
        VoicePending(
          utteranceId: receipt.deliveryId, backendIncarnationId: incarnation,
          deliveryId: receipt.deliveryId, text: receipt.text, receipt: receipt, error: nil,
          languageSpans: receipt.languageSpans)
      })
    await settle { receipts.count >= 2 }
    try await Task.sleep(for: .milliseconds(800))
    XCTAssertEqual(receipts, expected)
    XCTAssertEqual(model.state.utterances, [expected[1].deliveryId])
    XCTAssertEqual(Set(model.state.admissions.keys), [expected[1].deliveryId])
    XCTAssertEqual(Set(model.state.admissionLanguageSpans.keys), [expected[1].deliveryId])
    XCTAssertFalse(model.state.hasPendingAdmission)
    await model.shutdown()
  }

  func testContradictoryDuplicateCanonicalReceiptCannotReplaceAcceptedLanguageFact() async throws {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    var receipts: [ConversationMessage] = []
    let model = VoiceViewModel(control: control, media: media) { receipts.append($0) }
    model.start()
    await settle { model.state.capture == .listening }
    let incarnation = try XCTUnwrap(UUID(uuidString: "11111111-1111-4111-8111-111111111111"))
    let receipt = ConversationMessage(
      deliveryId: UUID(), recordId: 31, position: 31, text: "Hello",
      languageSpans: [LanguageSpan(language: "en", start: 0, end: 5)])
    await control.installPending([
      VoicePending(
        utteranceId: receipt.deliveryId,
        backendIncarnationId: incarnation, deliveryId: receipt.deliveryId, text: receipt.text,
        receipt: receipt, error: nil, languageSpans: receipt.languageSpans)
    ])
    await settle { receipts == [receipt] }
    let contradiction = ConversationMessage(
      deliveryId: receipt.deliveryId, recordId: 31,
      position: 31, text: "Hello", languageSpans: [LanguageSpan(language: "fr", start: 0, end: 5)])
    await control.installPending([
      VoicePending(
        utteranceId: receipt.deliveryId,
        backendIncarnationId: incarnation, deliveryId: receipt.deliveryId, text: contradiction.text,
        receipt: contradiction, error: nil, languageSpans: contradiction.languageSpans)
    ])
    await settle { model.state.capture == .failed(.invalidResponse) }
    XCTAssertEqual(receipts, [receipt])
    XCTAssertEqual(model.state.admissions[receipt.deliveryId], .saved(receipt))
    XCTAssertEqual(model.state.admissionLanguageSpans[receipt.deliveryId], receipt.languageSpans)
    XCTAssertFalse(model.state.wantsListening)
    await model.shutdown()
  }

  func testClassifiedNonSpeechPreservesWaitingReplyAndQualifiedSpeechInterrupts() async throws {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    let model = VoiceViewModel(control: control, media: media) { _ in
      XCTFail("Noise must not create accepted input")
    }
    model.start()
    await settle { model.state.capture == .listening }
    let session = await control.identity()
    let response = UUID()
    let input = UUID()
    let epoch = UUID()
    let preparing: [String: Any] = [
      "responseId": response.uuidString, "inputDeliveryId": input.uuidString,
      "outputEpoch": epoch.uuidString, "status": "Preparing", "error": NSNull(),
      "manifest": NSNull(),
    ]
    await control.append(
      try event(session: session, sequence: 1, kind: "Output", fields: ["output": preparing]))
    await settle { model.output.current?.responseId == response }
    XCTAssertFalse(model.output.receivedAudio)
    XCTAssertEqual(media.preparedOutputs, 0)

    // Exercise the production capture/qualification path through an injected
    // classifier. These probabilities test admission, not acoustic accuracy.
    let classifier = PendingReplyActivityClassifier()
    let notices = AsyncStream<UUID>.makeStream(bufferingPolicy: .bufferingNewest(8))
    let capture = VoiceActivityCapture(
      classifier: classifier,
      started: { epoch, _ in notices.continuation.yield(epoch) },
      failed: { _ in
        XCTFail("Valid fixture classification must not fail")
      })
    let projection = Task { @MainActor in
      for await epoch in notices.stream {
        guard capture.accepts(epoch) else { continue }
        media.speech?()
      }
    }
    XCTAssertTrue(
      capture.capture(
        frameCount: 1024, channels: 1, sampleRate: 16000,
        sample: { _, _ in 0.9 }))
    await classifier.waitForCalls(2)
    let interruptions = await control.interruptCalls()
    XCTAssertFalse(
      model.output.locallyInterrupted,
      "Classified non-speech must not retire a pending answer before text or audio exists")
    XCTAssertEqual(interruptions, 0)
    XCTAssertEqual(model.output.current?.status, .preparing)

    await classifier.setSpeech()
    XCTAssertTrue(
      capture.capture(
        frameCount: 1024, channels: 1, sampleRate: 16000,
        sample: { _, _ in 0.0001 }))
    await settle { model.output.locallyInterrupted }
    XCTAssertTrue(model.output.locallyInterrupted)
    await capture.stop()
    notices.continuation.finish()
    await projection.value
    await model.shutdown()
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
    if kind == "Final" { value["backendIncarnationId"] = "11111111-1111-4111-8111-111111111111" }
    return try JSONDecoder().decode(
      VoiceWireEvent.self, from: JSONSerialization.data(withJSONObject: value))
  }
}

@MainActor private final class FixtureMedia: VoiceMedia {
  var platform: (@MainActor @Sendable (VoicePlatformEvent) -> Void)?
  var platformRetired = false
  var captureFences = 0
  func observePlatform(_ receive: @escaping @MainActor @Sendable (VoicePlatformEvent) -> Void) {
    platform = receive
    platformRetired = false
  }
  func retirePlatformObservation() {
    platform = nil
    platformRetired = true
  }
  func fenceCapture() -> Task<Void, Never> {
    captureFences += 1
    return Task {}
  }
  var holdStop = false
  var stopWaiting = false
  var stopContinuation: CheckedContinuation<Void, Never>?
  var received: (@Sendable (VoiceOutputIdentity) -> Void)?
  var holdOutput = true
  var preparedOutputs = 0
  var outputWaiting = false
  var stoppedOutput = 0
  var outputContinuation: CheckedContinuation<Void, Never>?
  var speech: (@MainActor @Sendable () -> Void)?
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
  var joinMutes: [Bool] = []
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
    _ join: VoiceJoin, initiallyMuted: Bool, failure: @escaping @Sendable () -> Void,
    speechStarted: @escaping @MainActor @Sendable () -> Void,
    outputReceived: @escaping @Sendable (VoiceOutputIdentity) -> Void
  ) async throws {
    if let connectFailure { throw connectFailure }
    joinMutes.append(initiallyMuted)
    self.muted = initiallyMuted
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
  private var languageFailure = false
  func failLanguages() { languageFailure = true }
  func languages() async throws -> VoiceLanguages {
    if languageFailure {
      throw VoiceFailure.backend(
        code: "InvalidLanguageConfiguration",
        message: "ja is unsupported by synthesis")
    }
    return try JSONDecoder().decode(
      VoiceLanguages.self,
      from: Data(
        "{\"allowedLanguages\":[\"ru\",\"fr\",\"en\"],\"supportedLanguages\":[\"ru\",\"fr\",\"en\"]}"
          .utf8))
  }
  private var holdStart = false
  private var startGate: CheckedContinuation<Void, Never>?
  private var controlMutes: [Bool] = []
  func holdBootstrap() { holdStart = true }
  func bootstrapWaiting() -> Bool { startGate != nil }
  func releaseBootstrap() {
    holdStart = false
    startGate?.resume()
    startGate = nil
  }
  func controlMuteRequests() -> [Bool] { controlMutes }
  private var holdSnapshot = false
  private var snapshotGate: CheckedContinuation<Void, Never>?
  func holdSnapshots() { holdSnapshot = true }
  func snapshotWaiting() -> Bool { snapshotGate != nil }
  func releaseSnapshot() {
    holdSnapshot = false
    snapshotGate?.resume()
    snapshotGate = nil
  }
  private var holdResolution = false
  private var resolutionGate: CheckedContinuation<Void, Never>?
  func holdResolutions() { holdResolution = true }
  func resolutionWaiting() -> Bool { resolutionGate != nil }
  func releaseResolution() {
    holdResolution = false
    resolutionGate?.resume()
    resolutionGate = nil
  }
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
  private let incarnation = UUID(uuidString: "11111111-1111-4111-8111-111111111111")!
  private var notAccepted: Set<UUID> = []
  func rejectAdmission(_ id: UUID) { notAccepted.insert(id) }
  private var admissionReceipts: [UUID: ConversationMessage] = [:]
  func acceptAdmission(_ receipt: ConversationMessage) {
    admissionReceipts[receipt.deliveryId] = receipt
  }
  private var busyStarts = 0
  private var requestedMute: [Bool] = []
  func holdVoiceBusy(_ count: Int) { busyStarts = count }
  func muteRequests() -> [Bool] { requestedMute }
  private var startFailures = 0
  private var startIdentities: [UUID] = []
  func failStarts(_ count: Int) { startFailures = count }
  func requestIdentities() -> [UUID] { startIdentities }
  private var session = UUID()
  private var opened = 0
  private var ended = false
  private var producerMissing = false
  func removeProducer() { producerMissing = true }
  private var activeSeal = false
  func returnActiveSeal(_ value: Bool) { activeSeal = value }
  private var pendingOnEnd: VoicePending?
  func handFinalBeforeEnd(_ value: VoicePending) { pendingOnEnd = value }
  private var events: [VoiceWireEvent] = []
  private var pending: [VoicePending] = []
  private var canonicalSequence = 0
  private var queuedSnapshot: VoiceSnapshot?
  func replaySnapshot(_ snapshot: VoiceSnapshot) { queuedSnapshot = snapshot }
  func installPending(_ values: [VoicePending]) {
    pending = values
    canonicalSequence += 1
  }
  func start(requestId: UUID, muted: Bool) async throws -> VoiceJoin {
    startIdentities.append(requestId)
    requestedMute.append(muted)
    if busyStarts > 0 {
      busyStarts -= 1
      throw VoiceFailure.backend(code: "VoiceBusy", message: "Prior voice lease active")
    }
    if startFailures > 0 {
      startFailures -= 1
      throw VoiceFailure.connection
    }
    if holdStart { await withCheckedContinuation { startGate = $0 } }
    opened += 1
    ended = false
    session = UUID()
    events = []
    pending = []
    canonicalSequence = 0
    return try JSONDecoder().decode(
      VoiceJoin.self,
      from: JSONSerialization.data(withJSONObject: [
        "sessionId": session.uuidString, "roomName": session.uuidString,
        "startRequestId": requestId.uuidString, "backendIncarnationId": incarnation.uuidString,
        "joinDeadlineAt": 9_999_999_999_999, "controlDeadlineAt": 9_999_999_999_999,
        "participantIdentity": UUID().uuidString, "backendParticipantIdentity": UUID().uuidString,
        "mediaUrl": "ws://127.0.0.1:7880",
        "token": "fixture", "controlToken": String(repeating: "a", count: 64),
        "expiresAt": 9_999_999_999_999,
      ]))
  }
  func resolve(admissions: [VoiceAdmissionAssociation]) async throws -> VoiceAdmissionResolution {
    if holdResolution { await withCheckedContinuation { resolutionGate = $0 } }
    var answers: [[String: Any]] = []
    for association in admissions {
      let receipt = admissionReceipts[association.deliveryId]
      let encoded: Any =
        try receipt.map { try JSONSerialization.jsonObject(with: JSONEncoder().encode($0)) }
        ?? NSNull()
      answers.append([
        "backendIncarnationId": association.backendIncarnationId.uuidString,
        "sessionId": association.sessionId.uuidString,
        "deliveryId": association.deliveryId.uuidString,
        "status": receipt == nil
          ? (notAccepted.contains(association.deliveryId) ? "NotAccepted" : "Unknown") : "Accepted",
        "receipt": encoded,
      ])
    }
    return try JSONDecoder().decode(
      VoiceAdmissionResolution.self,
      from: JSONSerialization.data(withJSONObject: ["admissions": answers]))
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
    if let queuedSnapshot {
      self.queuedSnapshot = nil
      return queuedSnapshot
    }
    if holdSnapshot { await withCheckedContinuation { snapshotGate = $0 } }
    if snapshotFailure { throw VoiceFailure.connection }
    return try canonicalPage(after: after)
  }
  func seal(sessionId: UUID) async throws -> VoiceSealResult {
    if producerMissing {
      return .producerUnavailable(sessionId: sessionId, backendIncarnationId: incarnation)
    }
    try await end(sessionId: sessionId)
    if activeSeal { ended = false }
    return .ended(try canonicalPage(after: 0))
  }
  private func canonicalPage(after: Int) throws -> VoiceSnapshot {
    let payload =
      "{\"backendIncarnationId\":\"\(incarnation.uuidString)\",\"controlDeadlineAt\":9999999999999,\"sessionId\":\"\(session.uuidString)\",\"status\":\"\(ended ? "ended" : "active")\",\"muted\":false,\"sequence\":\(max(events.last?.sequence ?? 0, canonicalSequence)),\"events\":[],\"nextAfter\":null,\"firstSequence\":1,\"audioFramesReceived\":0,\"sampleFramesReceived\":0,\"pending\":[]}"
    let empty = try JSONDecoder().decode(VoiceSnapshot.self, from: Data(payload.utf8))
    return VoiceSnapshot(
      sessionId: empty.sessionId, status: empty.status, muted: false, sequence: empty.sequence,
      backendIncarnationId: incarnation,
      events: events.filter { $0.sequence > after }, nextAfter: nil,
      firstSequence: events.first?.sequence, pending: pending)
  }
  func mute(sessionId: UUID, muted: Bool) async throws { controlMutes.append(muted) }
  func end(sessionId: UUID) async throws {
    ended = true
    if let pendingOnEnd {
      pending = [pendingOnEnd]
      canonicalSequence += 1
      self.pendingOnEnd = nil
    }
  }
}

private actor FixtureRetryClock: VoiceRetryClock {
  private let gate = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
  private var delays: [Int] = []
  func sleep(milliseconds: Int) async throws {
    try Task.checkCancellation()
    delays.append(milliseconds)
    var iterator = gate.stream.makeAsyncIterator()
    _ = await iterator.next()
    try Task.checkCancellation()
  }
  func lastDelay() -> Int? { delays.last }
  func advance() { gate.continuation.yield(()) }
}

private actor GatedVoiceCheckpoint: VoiceAdmissionCheckpoint {
  private var value: [VoiceAdmissionAssociation] = []
  private var gate: CheckedContinuation<Void, Never>?
  private var waiter: CheckedContinuation<Void, Never>?
  private var first = true
  func load() throws -> [VoiceAdmissionAssociation] { value }
  func save(_ admissions: [VoiceAdmissionAssociation]) async throws {
    if first {
      first = false
      await withCheckedContinuation {
        gate = $0
        waiter?.resume()
        waiter = nil
      }
    }
    value = admissions
  }
  func isSaving() -> Bool { gate != nil }
  func waitForSave() async { if gate == nil { await withCheckedContinuation { waiter = $0 } } }
  func release() {
    gate?.resume()
    gate = nil
  }
}

extension VoiceViewModelTests {
  func testPlatformInterruptionFencesImmediatelyAndMutedResumeRequiresUserIntent() async {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    var interruptedInputs: [[UUID]] = []
    let model = VoiceViewModel(
      control: control, media: media,
      interruptConversation: { inputs, _ in interruptedInputs.append(inputs) }
    ) { _ in }
    model.start()
    await settle { model.state.capture == .listening }
    model.toggleMute()
    await settle { model.state.capture == .muted }
    media.platform?(.interrupted)
    XCTAssertEqual(model.state.capture, .paused)
    XCTAssertEqual(media.captureFences, 2)
    media.platform?(.servicesLost)
    media.platform?(.routeChanged(privateOutputRemoved: true))
    XCTAssertEqual(media.captureFences, 2)
    XCTAssertEqual(interruptedInputs.count, 1)
    XCTAssertTrue(model.state.wantsMuted)
    media.platform?(.resumeRecommended(false))
    XCTAssertEqual(model.state.capture, .paused)
    let count = await control.openedCount()
    XCTAssertEqual(count, 1)
    model.resume()
    await settle { model.state.capture == .muted }
    XCTAssertEqual(media.joinMutes, [false, true])
    model.end()
    await settle { model.state.capture == .ended }
    XCTAssertTrue(media.platformRetired)
    await model.shutdown()
  }
  func testExplicitRecoveryFailureRemainsPausedAndEndRejectsHeldRecovery() async {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    let model = VoiceViewModel(control: control, media: media) { _ in }
    model.start()
    await settle { model.state.capture == .listening }
    media.platform?(.servicesLost)
    media.connectFailure = .capture
    model.resume()
    await settle { model.state.capture == .paused }
    XCTAssertTrue(model.state.canResume)
    media.connectFailure = nil
    media.holdConnect = true
    model.resume()
    await settle { media.connectWaiting }
    model.end()
    media.resolveConnect()
    await settle { model.state.capture == .ended }
    XCTAssertFalse(model.state.wantsListening)
    await model.shutdown()
  }
}

extension VoiceViewModelTests {
  func testPauseSealEnumeratesHandedFinalBeforeResumeAndKeepsCaptureHeld() async throws {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    var receipts: [ConversationMessage] = []
    let model = VoiceViewModel(control: control, media: media) { receipts.append($0) }
    model.start()
    await settle { model.state.capture == .listening }
    let input = UUID()
    let receipt = ConversationMessage(
      deliveryId: input, recordId: 0, position: 0, text: "Already handed")
    let pending = VoicePending(
      utteranceId: input,
      backendIncarnationId: UUID(uuidString: "11111111-1111-4111-8111-111111111111")!,
      deliveryId: input, text: receipt.text, receipt: nil, error: nil)
    await control.handFinalBeforeEnd(pending)
    XCTAssertFalse(model.state.hasPendingAdmission)
    media.platform?(.interrupted)
    model.resume()
    await settle { model.state.capture == .checkingPreviousSpeech }
    XCTAssertTrue(model.state.hasPendingAdmission)
    XCTAssertEqual(media.joinMutes, [false, true])
    XCTAssertTrue(receipts.isEmpty)
    model.end()
    await control.acceptAdmission(receipt)
    await settle { receipts == [receipt] }
    XCTAssertEqual(model.state.capture, .ended)
    XCTAssertEqual(media.preparedOutputs, 0)
    await model.shutdown()
  }
}

extension VoiceViewModelTests {
  func testPlatformSealCannotBeginBeforeHeldLocalSDKStopCompletes() async {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    let model = VoiceViewModel(control: control, media: media) { _ in }
    model.start()
    await settle { model.state.capture == .listening }
    media.holdStop = true
    media.platform?(.interrupted)
    await settle { media.stopWaiting }
    try? await Task.sleep(for: .milliseconds(30))
    let beforeStop = await control.wasEnded()
    XCTAssertFalse(beforeStop)
    media.resolveStop()
    await settle { media.disconnected }
    for _ in 0..<100 {
      if await control.wasEnded() { break }
      try? await Task.sleep(for: .milliseconds(10))
    }
    let afterStop = await control.wasEnded()
    XCTAssertTrue(afterStop)
    model.end()
    await model.shutdown()
  }
}

extension VoiceViewModelTests {
  func testActiveSealPageCannotClearAuthorityFenceOrStartFreshCapture() async {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    let model = VoiceViewModel(control: control, media: media) { _ in }
    model.start()
    await settle { model.state.capture == .listening }
    await control.returnActiveSeal(true)
    media.platform?(.interrupted)
    model.resume()
    await settle { model.state.capture == .paused }
    let opens = await control.openedCount()
    XCTAssertEqual(opens, 1)
    XCTAssertTrue(model.state.canResume)
    await control.returnActiveSeal(false)
    model.resume()
    await settle { model.state.capture == .listening }
    let recovered = await control.openedCount()
    XCTAssertEqual(recovered, 2)
    model.end()
    await model.shutdown()
  }
}

extension VoiceViewModelTests {
  func testPausedRestartAbsentProducerAllowsExplicitFreshResumeWithoutNewInput() async {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    var receipts: [ConversationMessage] = []
    let model = VoiceViewModel(control: control, media: media) { receipts.append($0) }
    model.start()
    await settle { model.state.capture == .listening }
    await control.removeProducer()
    media.platform?(.interrupted)
    model.resume()
    await settle { model.state.capture == .listening }
    let opens = await control.openedCount()
    XCTAssertEqual(opens, 2)
    XCTAssertEqual(media.joinMutes, [false, false])
    XCTAssertTrue(receipts.isEmpty)
    model.end()
    await model.shutdown()
  }
}

private actor PendingReplyActivityClassifier: VoiceActivityClassifier {
  private var probability: Float = 0.01
  private var calls = 0
  private var waiter: CheckedContinuation<Void, Never>?
  private var target = 0
  func probability(_ frame: [Float]) throws -> Float {
    guard frame.count == 512 else { throw VoiceActivityError.invalidFrame }
    calls += 1
    if calls >= target {
      waiter?.resume()
      waiter = nil
    }
    return probability
  }
  func reset() {}
  func setSpeech() { probability = 0.9 }
  func waitForCalls(_ count: Int) async {
    if calls >= count { return }
    target = count
    await withCheckedContinuation { waiter = $0 }
  }
}
