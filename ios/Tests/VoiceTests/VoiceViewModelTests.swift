import Conversation
import XCTest

@testable import Voice

@MainActor final class VoiceViewModelTests: XCTestCase {
  func testBackendRestartDuringAnswerRetriesUnavailableSealAndReconnectsWithoutResume() async throws {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    media.holdOutput = false
    let clock = FixtureRetryClock()
    let model = VoiceViewModel(control: control, media: media, retryClock: clock) { _ in
      XCTFail("Reconnection must not fabricate or resubmit an input")
    }
    model.start()
    await settle { model.state.capture == .listening }
    let session = await control.identity()
    await control.append(try event(session: session, sequence: 1, kind: "Output", fields: [
      "output": outputValue(session: session, input: UUID(), response: UUID(), epoch: UUID())
    ]))
    await settle { media.preparedOutputs == 1 }
    await control.failSeals(2)
    media.failure?()
    await settle { model.state.capture == .paused || model.state.capture == .hostUnavailable }
    for _ in 0..<200 {
      if await control.sealCalls() == 1 { break }
      await Task.yield()
    }
    for _ in 0..<20 { await Task.yield() }
    XCTAssertEqual(model.state.capture, .hostUnavailable, "An offline cleanup request must not demand Resume")
    guard model.state.capture == .hostUnavailable else { await model.shutdown(); return }
    await clock.advance()
    await settle { model.state.capture == .hostUnavailable && model.state.retryStep == 2 }
    await control.removeProducer()
    await clock.advance()
    await settle { model.state.capture == .listening }
    XCTAssertFalse(model.output.closed)
    let seals = await control.sealCalls()
    XCTAssertEqual(seals, 3, "Reconnect requires closure evidence for the retired producer")
    let freshSession = await control.identity()
    XCTAssertNotEqual(freshSession, session)
    await model.shutdown()
  }

  func testGenerationCueUsesMediaPortOnlyForLiveEligibleOwner() async {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    let model = VoiceViewModel(control: control, media: media) { _ in }
    let input = UUID()
    let response = UUID()
    model.generationCue(input: input, response: response, cue: .generationStarted)
    XCTAssertTrue(media.progressCues.isEmpty)
    model.start()
    await settle { model.state.capture == .listening }
    model.generationCue(input: input, response: response, cue: .generationStarted)
    model.generationCue(input: input, response: response, cue: .textReady)
    XCTAssertEqual(media.progressCues, [.generationStarted, .textReady])
    model.cancelGenerationCue()
    XCTAssertEqual(media.cueCancellations, 1)
    model.inputIntent(UUID())
    model.generationCue(input: input, response: response, cue: .generationStarted)
    XCTAssertEqual(media.progressCues.count, 2)
    await model.shutdown()
    model.generationCue(input: input, response: response, cue: .textReady)
    XCTAssertEqual(media.progressCues.count, 2)
  }

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

  func testMicrophoneIntentLifetimeSurvivesTransientRoomTeardown() async {
    let control = FixtureControl(), media = FixtureMedia(allowed: true)
    let model = VoiceViewModel(control: control, media: media) { _ in }
    model.start()
    await settle { model.state.capture == .listening }
    XCTAssertTrue(media.recordingPrepared, "User microphone intent must already own the SDK engine before Room teardown")
    await control.failSnapshots()
    await settle { model.state.capture == .hostUnavailable }
    await settle { media.disconnected }
    XCTAssertTrue(media.recordingPrepared, "Transient room cleanup must retain intended capture")
    XCTAssertEqual(media.preparationChanges.first, false)
    await settle { media.captureDevice.inputRunning && model.state.execution.microphoneLifetime.settledRevision == model.state.execution.microphoneLifetime.revision }
    XCTAssertTrue(media.captureDevice.inputRunning, "Actual SDK input must be running after transient room cleanup")
    model.end()
    await settle { !media.recordingPrepared }
    await model.shutdown()
  }

  func testMutingOfflineReleasesMicrophoneIntentWithoutWaitingForNewRoom() async {
    let control = FixtureControl(), media = FixtureMedia(allowed: true)
    let model = VoiceViewModel(control: control, media: media) { _ in }
    model.start()
    await settle { model.state.capture == .listening }
    await control.failSnapshots()
    await settle { model.state.capture == .hostUnavailable }
    model.toggleMute()
    await settle { model.state.wantsMuted }
    await settle { media.preparationChanges.last == false && !media.recordingPrepared }
    XCTAssertFalse(media.recordingPrepared)
    await model.shutdown()
  }

  func testLateMicrophonePreparationIsCompensatedAfterEndAndCannotStartRoom() async {
    let control = FixtureControl(), media = FixtureMedia(allowed: true)
    media.holdPreparation = true
    let model = VoiceViewModel(control: control, media: media) { _ in }
    model.start()
    await settle { media.preparationWaiting }
    XCTAssertTrue(media.joinMutes.isEmpty, "Room capture waits for preparation")
    model.end()
    media.resolvePreparation()
    await settle { media.preparationChanges == [false, true, false] }
    await settle { !media.recordingPrepared }
    XCTAssertTrue(media.joinMutes.isEmpty, "A cancelled connect cannot publish after late preparation")
    await model.shutdown()
  }

  func testLateSDKPreparationAfterEndCannotStartActualRecording() async {
    let media = FixtureMedia(allowed: true)
    media.captureDevice.holdPreparation = true
    let model = VoiceViewModel(control: FixtureControl(), media: media) { _ in }
    model.start()
    await settle { media.captureDevice.preparationWaiting }
    model.end()
    media.captureDevice.resolvePreparation()
    await settle { !model.state.microphoneReleasePending && !media.recordingPrepared }
    XCTAssertFalse(media.captureDevice.calls.contains("startRecording"), "A revoked acquisition must not unmute the SDK after End")
    XCTAssertFalse(media.captureDevice.inputRunning)
    await model.shutdown()
  }

  func testMicrophoneLifetimeReleasesOnPlatformPauseAndPreservesMutedIntent() async {
    let control = FixtureControl(), media = FixtureMedia(allowed: true)
    let model = VoiceViewModel(control: control, media: media) { _ in }
    model.start()
    await settle { model.state.capture == .listening }
    media.platform?(.interrupted)
    await settle { model.state.capture == .paused && !media.recordingPrepared }
    XCTAssertEqual(media.preparationChanges, [false, true, false])
    XCTAssertTrue(model.state.wantsListening)
    XCTAssertFalse(model.state.wantsMuted)
    await model.shutdown()
  }

  func testMicrophonePreparationAndReleaseFailuresRemainExplicit() async {
    let control = FixtureControl(), media = FixtureMedia(allowed: true)
    media.preparationFailure = .capture
    let model = VoiceViewModel(control: control, media: media) { _ in }
    model.start()
    await settle { model.state.capture == .failed(.capture) }
    await settle { media.preparationChanges == [false, true, false] }
    XCTAssertTrue(media.joinMutes.isEmpty)
    await model.shutdown()
    let other = FixtureMedia(allowed: true)
    let live = VoiceViewModel(control: FixtureControl(), media: other) { _ in }
    live.start()
    await settle { live.state.capture == .listening }
    other.releasePreparationFailure = .capture
    live.end()
    await settle { live.state.execution.microphoneLifetime.failure == .capture }
    XCTAssertFalse(live.state.execution.microphoneLifetime.desired)
    let shutdown = await live.shutdown()
    if case .success = shutdown { XCTFail("Failed SDK release must not report a clean shutdown") }
    XCTAssertEqual(live.state.execution.microphoneLifetime.failure, .capture)
    XCTAssertNil(live.state.execution.microphoneLifetime.applied)
    XCTAssertTrue(live.state.microphoneReleasePending)
    XCTAssertFalse(live.state.canStart)
    XCTAssertTrue(live.state.canSwitchServer, "A failed retiring owner can retry the awaited shutdown")
    XCTAssertTrue(other.recordingPrepared, "A refusal leaves the fake SDK engine on")
    XCTAssertEqual(other.preparationChanges, [false, true, false, false, false, false])
    other.releasePreparationFailure = nil
    live.end()
    await settle { !live.state.microphoneReleasePending && !other.recordingPrepared }
    XCTAssertNil(live.state.microphoneCleanupFailure)
    XCTAssertTrue(live.state.requiresReplacement, "Confirmed cleanup permits replacement, never revival of a retired owner")
    XCTAssertTrue(live.state.canSwitchServer)
    if case .failure = await live.shutdown() { XCTFail("An explicit retry must recover confirmed cleanup") }
  }

  func testResumeRecordsIntentWhileMicrophoneReleaseIsHeldButNewRoomWaits() async {
    let control = FixtureControl(), media = FixtureMedia(allowed: true)
    let model = VoiceViewModel(control: control, media: media) { _ in }
    model.start()
    await settle { model.state.capture == .listening }
    media.holdPreparationRelease = true
    media.platform?(.interrupted)
    await settle { model.state.capture == .paused && media.preparationReleaseWaiting }
    XCTAssertTrue(model.state.canResume)
    model.resume()
    await settle { model.state.capture != .paused }
    XCTAssertTrue(model.state.wantsListening)
    XCTAssertEqual(media.joinMutes.count, 1, "Replacement capture cannot bypass the held SDK release")
    media.resolvePreparationRelease()
    await settle { model.state.capture == .listening && media.joinMutes.count == 2 }
    XCTAssertEqual(media.preparationChanges, [false, true, false, true])
    await model.shutdown()
  }

  func testOnlyMatchingCaptureTeardownRenewsCurrentlyUnmutedLifetime() throws {
    let initial = try VoiceLifecycleITFMapping().initial()
    for capture in [false, true] {
      let stopped = stopVoiceMedia(initial, capture: capture, output: true)
      let request = try XCTUnwrap(stopped.state.execution.localStop)
      let completion = VoiceInput(event: .completed(request, .stopped), proposedStartRequestId: UUID())
      let resumed = transitionVoice(stopped.state, completion)
      XCTAssertEqual(resumed.commands.contains { if case .microphoneLifetime(_, true) = $0 { true } else { false } }, capture)
      XCTAssertFalse(transitionVoice(resumed.state, completion).commands.contains { if case .microphoneLifetime(_, true) = $0 { true } else { false } })
      let muted = stopped.state.replacing(capture: stopped.state.captureModel.replacing(intent: .listening(muted: true)))
      XCTAssertFalse(transitionVoice(muted, completion).commands.contains { if case .microphoneLifetime(_, true) = $0 { true } else { false } })
    }
    let disconnect = reserveVoice(initial, .disconnect)
    let request = try XCTUnwrap(disconnect.commands.compactMap { command -> VoiceRequest? in
      if case .run(let request, .disconnect, _) = command { return request }; return nil
    }.first)
    let completed = transitionVoice(disconnect.state, .init(event: .completed(request, .disconnected), proposedStartRequestId: UUID()))
    XCTAssertTrue(completed.commands.contains { if case .microphoneLifetime(_, true) = $0 { true } else { false } })
  }

  func testMicrophoneLifetimeStaleCompletionCannotChangeNewIntent() throws {
    let initial = try VoiceLifecycleITFMapping().initial()
    let lifetime = VoiceMicrophoneLifetimeState(permissionGranted: true, desired: true, revision: 5, settledRevision: 4, applied: true)
    let state = initial.replacing(execution: initial.execution.replacing(microphoneLifetime: lifetime))
    let old = transitionVoice(state, .init(event: .microphoneLifetimeSettled(3, .failure(.capture)), proposedStartRequestId: UUID()))
    XCTAssertEqual(old.state, state)
    XCTAssertTrue(old.commands.isEmpty)
  }

  func testMicrophoneSetterCoalescesIntentAndCannotApplyOldReleaseAfterNewAcquire() async {
    let media = FixtureMedia(allowed: true)
    media.holdPreparation = true
    var completed: [Int] = []
    let lane = VoiceMicrophoneLifetimeInterpreter(media: media) { event in
      if case .microphoneLifetimeSettled(let revision, _) = event { completed.append(revision) }
    }
    lane.reconcile(revision: 1, enabled: true)
    await settle { media.preparationWaiting }
    lane.reconcile(revision: 2, enabled: false)
    lane.reconcile(revision: 3, enabled: true)
    media.resolvePreparation()
    await lane.settled()
    XCTAssertTrue(media.recordingPrepared)
    XCTAssertEqual(completed, [3])
    XCTAssertEqual(media.preparationChanges, [true, true])
    lane.reconcile(revision: 2, enabled: false)
    await lane.settled()
    XCTAssertTrue(media.recordingPrepared, "An older scope cannot release the newer microphone intent")
    lane.reconcile(revision: 4, enabled: false)
    await lane.settled()
    XCTAssertFalse(media.recordingPrepared)
  }

  func testSpontaneousMicrophoneSetterCancellationIsNotSuccessfulCleanup() async {
    let media = FixtureMedia(allowed: true)
    media.preparationThrownError = CancellationError()
    let model = VoiceViewModel(control: FixtureControl(), media: media) { _ in }
    model.start()
    await settle { model.state.capture == .failed(.unexpectedOperation) }
    XCTAssertTrue(media.joinMutes.isEmpty)
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

  func testRetiredMuteCompletesBeforeReplacementCaptureCanListen() async {
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
    XCTAssertTrue(model.state.wantsListening)
    media.resolveMute()
    await settle { model.state.capture == .listening }
    XCTAssertFalse(media.connectedDuringMute)
    XCTAssertFalse(media.muted)
    XCTAssertFalse(model.state.wantsMuted)
    model.toggleMute()
    await settle { model.state.capture == .muted }
    XCTAssertTrue(media.muted)
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

  func testLateBootstrapCleanupRetriesExactSessionAndShutdownWaitsForAcknowledgement() async {
    for firstFailure in [FixtureEndFailure.connection, .spontaneousCancellation] {
      await checkLateBootstrapCleanup(firstFailure: firstFailure)
    }
  }

  private func checkLateBootstrapCleanup(firstFailure: FixtureEndFailure) async {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    await control.holdBootstrap()
    await control.failFirstEndAndHoldRetry(firstFailure)
    let model = VoiceViewModel(control: control, media: media) { _ in }
    model.start()
    let bootstrapEntered = await control.waitForBootstrap()
    XCTAssertTrue(bootstrapEntered)
    model.end()
    await settle { model.state.capture == .ended }
    await control.releaseBootstrap()
    let retryEntered = await control.waitForEndRetry()
    XCTAssertTrue(retryEntered, "Failed cleanup must retry rather than forget the late session")
    let lateSession = await control.identity()
    let attempts = await control.endAttempts()
    XCTAssertEqual(attempts, [lateSession, lateSession])
    XCTAssertTrue(media.joinMutes.isEmpty, "Retired bootstrap must never open capture")
    var shutdownEntered = false
    var shutdownFinished = false
    let shutdown = Task {
      shutdownEntered = true
      await model.shutdown()
      shutdownFinished = true
      return await control.endRetryAcknowledged()
    }
    await settle { shutdownEntered }
    XCTAssertFalse(shutdownFinished)
    await control.releaseEndRetry()
    let acknowledgedBeforeShutdown = await shutdown.value
    XCTAssertTrue(acknowledgedBeforeShutdown)
    XCTAssertTrue(shutdownFinished)
    XCTAssertTrue(media.joinMutes.isEmpty)
    XCTAssertFalse(model.state.wantsListening)
    let replacement = VoiceViewModel(control: control, media: media) { _ in }
    replacement.start()
    await settle { replacement.state.capture == .listening }
    let replacementSession = await control.identity()
    XCTAssertNotEqual(replacementSession, lateSession)
    XCTAssertEqual(media.joinMutes, [false])
    await replacement.shutdown()
  }

  func testLocalCutAcceptsEveryCanonicalTerminalWithoutPreparingAgain() async throws {
    for status in ["Interrupted", "Delivered", "Failed"] {
      let control = FixtureControl()
      let media = FixtureMedia(allowed: true)
      media.holdOutput = false
      let model = VoiceViewModel(control: control, media: media) { _ in }
      model.start()
      await settle { model.state.capture == .listening }
      let session = await control.identity()
      var output = outputValue(session: session, input: UUID(), response: UUID(), epoch: UUID())
      output["status"] = "Playing"
      await control.append(
        try event(session: session, sequence: 1, kind: "Output", fields: ["output": output]))
      await settle { media.preparedOutputs == 1 }
      XCTAssertEqual(model.output.current?.status, .playing)
      model.speechStarted()
      XCTAssertTrue(model.output.locallyInterrupted)
      var terminal = output
      terminal["status"] = status
      if status == "Failed" {
        terminal["error"] = ["code": "AudioUnavailable", "message": "Output failed"]
      }
      await control.append(
        try event(session: session, sequence: 2, kind: "Output", fields: ["output": terminal]))
      await settle { model.state.sequence == 2 }
      XCTAssertEqual(model.output.current?.status.rawValue, status)
      XCTAssertEqual(model.output.unavailable, status == "Failed")
      XCTAssertEqual(model.output.locallyInterrupted, status != "Failed")
      XCTAssertNil(model.output.prepared)
      XCTAssertEqual(media.preparedOutputs, 1)
      await control.append(
        try event(session: session, sequence: 3, kind: "Output", fields: ["output": output]))
      await settle { model.state.sequence == 3 }
      XCTAssertEqual(model.output.current?.status.rawValue, status)
      XCTAssertEqual(media.preparedOutputs, 1)
      await model.shutdown()
    }
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

  func testRetiredReadinessResultsCannotFailOrAuthorizeReplacementEpoch() async throws {
    for fails in [false, true] {
      let control = FixtureControl()
      let media = FixtureMedia(allowed: true)
      media.holdOutput = false
      await control.holdReadiness()
      let model = VoiceViewModel(control: control, media: media) { _ in }
      model.start()
      await settle { model.state.capture == .listening }
      let session = await control.identity()
      let oldInput = UUID()
      let oldResponse = UUID()
      let oldEpoch = UUID()
      await control.append(
        try event(
          session: session, sequence: 1, kind: "Output",
          fields: [
            "output": outputValue(
              session: session, input: oldInput, response: oldResponse, epoch: oldEpoch)
          ]))
      let firstReadyEntered = await control.waitForReadiness(1)
      XCTAssertTrue(firstReadyEntered)
      guard firstReadyEntered else {
        await control.resolveReady()
        await model.shutdown()
        return
      }
      let firstReadyCalls = await control.readyCalls()
      XCTAssertEqual(firstReadyCalls, 1)
      let freshInput = UUID()
      let freshResponse = UUID()
      let freshEpoch = UUID()
      model.inputIntent(freshInput)
      await control.append(
        try event(
          session: session, sequence: 2, kind: "Output",
          fields: [
            "output": outputValue(
              session: session, input: freshInput, response: freshResponse, epoch: freshEpoch)
          ]))
      await settle { model.output.current?.outputEpoch == freshEpoch }
      media.received?(
        VoiceOutputIdentity(
          inputDeliveryId: oldInput, responseId: oldResponse, outputEpoch: oldEpoch))
      await settle { media.preparedOutputs == 2 }
      let freshReadyEntered = await control.waitForReadiness(2)
      XCTAssertTrue(freshReadyEntered)
      let readyCalls = await control.readyCalls()
      XCTAssertEqual(readyCalls, 2)
      XCTAssertEqual(model.output.current?.outputEpoch, freshEpoch)
      XCTAssertFalse(model.output.locallyInterrupted)
      XCTAssertFalse(model.output.unavailable)
      XCTAssertFalse(model.output.receivedAudio)
      media.received?(
        VoiceOutputIdentity(
          inputDeliveryId: freshInput, responseId: freshResponse, outputEpoch: freshEpoch))
      await settle { model.output.receivedAudio }
      XCTAssertEqual(model.output.current?.responseId, freshResponse)
      await control.resolveReady(failing: fails)
      let oldRequestReturned = await control.waitForReadinessReturns(2)
      XCTAssertTrue(oldRequestReturned)
      XCTAssertEqual(model.output.current?.outputEpoch, freshEpoch)
      XCTAssertFalse(model.output.unavailable)
      XCTAssertFalse(model.output.locallyInterrupted)
      XCTAssertTrue(model.output.receivedAudio)
      await model.shutdown()
    }
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

  func testAcceptedCallbackEndCannotUnmuteRetiredCapture() async throws {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    let checkpoint = VolatileVoiceAdmissionCheckpoint()
    let association = VoiceAdmissionAssociation(
      backendIncarnationId: UUID(uuidString: "11111111-1111-4111-8111-111111111111")!,
      sessionId: UUID(), deliveryId: UUID())
    try await checkpoint.save([association])
    var receipts: [ConversationMessage] = []
    var endOnAcceptance: (() -> Void)?
    let model = VoiceViewModel(control: control, media: media, checkpoint: checkpoint) { receipt in
      receipts.append(receipt)
      endOnAcceptance?()
    }
    endOnAcceptance = { model.end() }
    model.start()
    await settle { model.state.capture == .checkingPreviousSpeech }
    XCTAssertEqual(media.joinMutes, [true])
    XCTAssertTrue(media.muted)
    let receipt = ConversationMessage(
      deliveryId: association.deliveryId, recordId: 98, position: 98,
      text: "Previously handed speech")
    await control.acceptAdmission(receipt)
    await settle { model.state.capture == .ended && receipts == [receipt] }
    await model.shutdown()
    XCTAssertEqual(receipts, [receipt])
    XCTAssertEqual(
      media.unmutesAfterFence, 0, "Acceptance must not unmute after its callback ends capture")
    XCTAssertTrue(media.muted)
    let saved = await checkpoint.load()
    XCTAssertTrue(saved.isEmpty)
    let replacement = VoiceViewModel(control: control, media: media, checkpoint: checkpoint) { _ in
    }
    replacement.start()
    await settle { replacement.state.capture == .listening }
    XCTAssertEqual(media.joinMutes, [true, false])
    XCTAssertFalse(media.muted)
    await replacement.shutdown()
    endOnAcceptance = nil
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

  func testContradictoryDetectionReceiptCannotSettlePendingFinal() async throws {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    var receipts: [ConversationMessage] = []
    let model = VoiceViewModel(control: control, media: media) { receipts.append($0) }
    model.start()
    await settle { model.state.capture == .listening }
    let session = await control.identity()
    let delivery = UUID()
    await control.append(
      try event(
        session: session, sequence: 1, kind: "Final",
        fields: [
          "utteranceId": delivery.uuidString, "deliveryId": delivery.uuidString,
          "text": "Привет", "languageSpans": [], "detectedLanguage": "ru",
        ]))
    await settle { model.state.hasPendingAdmission }
    let wrong = ConversationMessage(
      deliveryId: delivery, recordId: 0, position: 0,
      text: "Привет", detectedLanguage: "fr", responseLanguage: "fr")
    await control.append(
      try event(
        session: session, sequence: 2, kind: "Accepted",
        fields: [
          "utteranceId": delivery.uuidString,
          "receipt": try JSONSerialization.jsonObject(with: JSONEncoder().encode(wrong)),
        ]))
    await settle { model.state.sequence >= 2 }
    XCTAssertTrue(receipts.isEmpty)
    XCTAssertTrue(model.state.hasPendingAdmission)
    XCTAssertEqual(model.state.pendingAssociations.first?.detectedLanguage, "ru")
    let correct = ConversationMessage(
      deliveryId: delivery, recordId: 0, position: 0,
      text: "Привет", detectedLanguage: "ru", responseLanguage: "ru")
    await control.append(
      try event(
        session: session, sequence: 3, kind: "Accepted",
        fields: [
          "utteranceId": delivery.uuidString,
          "receipt": try JSONSerialization.jsonObject(with: JSONEncoder().encode(correct)),
        ]))
    await settle { receipts == [correct] }
    XCTAssertEqual(model.state.admissions[delivery], .saved(correct))
    await model.shutdown()
  }

  func testCaptureDiscontinuityIsInputOnlyWithOrderedSnapshotsAndPreservedAdmissions() throws {
    let initial = try VoiceLifecycleITFMapping().initial()
    let origin = try XCTUnwrap(initial.origin)
    let open = UUID(), handed = UUID(), previousUnrecognized = UUID()
    var wire = outputValue(session: origin.sessionId, input: UUID(), response: UUID(), epoch: UUID())
    wire["status"] = "Playing"
    let playing = try JSONDecoder().decode(VoiceOutput.self, from: JSONSerialization.data(withJSONObject: wire))
    let association = VoiceAdmissionAssociation(backendIncarnationId: origin.backendIncarnationId,
      sessionId: origin.sessionId, deliveryId: handed)
    for muted in [false, true] {
      for abandoned in [Optional(open), nil, Optional(handed), Optional(UUID())] {
        let capture = initial.captureModel.replacing(intent: .listening(muted: muted),
          capture: muted ? .muted : .listening, tentative: "unfinished input", tentativeUtterance: .some(open),
          inputNotice: .some(.unrecognized(previousUnrecognized)))
        let recovery = initial.recovery.replacing(associations: [handed: association],
          admissions: [handed: .checking(deliveryId: handed, text: "already finalized")])
        let state = initial.replacing(capture: capture, recovery: recovery,
          output: initial.output.replacing(current: .some(playing), receivedAudio: true))
        let gap = try event(session: origin.sessionId, sequence: 1, kind: "Error", fields: [
          "utteranceId": abandoned.map { $0.uuidString as Any } ?? NSNull(),
          "code": "CaptureDiscontinuity", "message": "Microphone audio was interrupted; repeat the unfinished utterance"])
        let page = VoiceSnapshot(sessionId: origin.sessionId, status: "active", muted: muted, sequence: 1,
          backendIncarnationId: origin.backendIncarnationId, events: [gap], nextAfter: nil)
        let result = voiceSnapshotObserved(state, requestOrigin: origin, page: page, proposedId: UUID())
        XCTAssertEqual(result.state.capture, state.capture)
        XCTAssertEqual(result.state.intent, state.intent)
        XCTAssertEqual(result.state.output, state.output)
        XCTAssertEqual(result.state.recovery, recovery)
        let expectedNotice: VoiceState.InputNotice = abandoned == open ? .captureDiscontinuity(open) : .unrecognized(previousUnrecognized)
        XCTAssertEqual(result.state.inputNotice, expectedNotice)
        XCTAssertEqual(result.state.tentative, abandoned == nil || abandoned == open ? "" : "unfinished input")
        XCTAssertFalse(result.commands.contains { if case .run = $0 { true } else { false } })
        let replay = voiceSnapshotObserved(result.state, requestOrigin: origin, page: page, proposedId: UUID())
        XCTAssertEqual(replay.state, result.state)
        XCTAssertTrue(replay.commands.isEmpty)
        let old = VoiceOrigin(sessionId: UUID(), backendIncarnationId: origin.backendIncarnationId)
        XCTAssertEqual(voiceSnapshotObserved(result.state, requestOrigin: old, page: page, proposedId: UUID()).state, result.state)
        let late = try event(session: old.sessionId, sequence: 2, kind: "Error", fields: [
          "utteranceId": NSNull(), "code": "CaptureDiscontinuity", "message": "Old capture gap"])
        let latePage = VoiceSnapshot(sessionId: origin.sessionId, status: "active", muted: muted, sequence: 2,
          backendIncarnationId: origin.backendIncarnationId, events: [late], nextAfter: nil)
        let ignored = voiceSnapshotObserved(result.state, requestOrigin: origin, page: latePage, proposedId: UUID())
        XCTAssertEqual(ignored.state.inputNotice, result.state.inputNotice)
        XCTAssertEqual(ignored.state.output, result.state.output)
        XCTAssertTrue(ignored.commands.isEmpty)
        let receipt = ConversationMessage(deliveryId: handed, recordId: 1, position: 0, text: "already finalized")
        let accepted = acceptVoiceAdmission(result.state, association: association, receipt: receipt,
          expectedText: "already finalized", proposedId: UUID())
        XCTAssertEqual(accepted.state.admissions[handed], .saved(receipt))
        XCTAssertEqual(accepted.state.inputNotice, expectedNotice)
        if abandoned == open {
          let onset = transitionVoice(result.state, .init(event: .speechIntent, proposedStartRequestId: UUID()))
          XCTAssertNil(onset.state.inputNotice)
          let next = try event(session: origin.sessionId, sequence: 3, kind: "Interim", fields: [
            "utteranceId": UUID().uuidString, "text": "next utterance"])
          let nextPage = VoiceSnapshot(sessionId: origin.sessionId, status: "active", muted: false, sequence: 3,
            backendIncarnationId: origin.backendIncarnationId, events: [next], nextAfter: nil)
          if !muted {
            XCTAssertNil(voiceSnapshotObserved(result.state, requestOrigin: origin, page: nextPage, proposedId: UUID()).state.inputNotice)
          }
        }
      }
    }
  }

  func testCaptureDiscontinuityKeepsLivePlaybackAndNextFinalClearsNotice() async throws {
    for scoped in [false, true] {
      let control = FixtureControl()
      let media = FixtureMedia(allowed: true)
      media.holdOutput = false
      let model = VoiceViewModel(control: control, media: media) { _ in }
      model.start()
      await settle { model.state.capture == .listening }
      let session = await control.identity()
      var wire = outputValue(session: session, input: UUID(), response: UUID(), epoch: UUID())
      wire["status"] = "Playing"
      await control.append(try event(session: session, sequence: 1, kind: "Output", fields: ["output": wire]))
      await settle { model.output.current?.status == .playing }
      let output = model.output
      let stops = media.stoppedOutput
      let abandoned: UUID? = scoped ? UUID() : nil
      await control.append(try event(session: session, sequence: 2, kind: "Error", fields: [
        "utteranceId": abandoned.map { $0.uuidString as Any } ?? NSNull(),
        "code": "CaptureDiscontinuity", "message": "Microphone audio was interrupted; repeat the unfinished utterance"]))
      await settle { model.state.sequence >= 2 }
      XCTAssertEqual(model.state.inputNotice, abandoned.map { .captureDiscontinuity($0) })
      XCTAssertEqual(model.state.capture, .listening)
      XCTAssertEqual(model.output, output)
      XCTAssertEqual(media.stoppedOutput, stops)
      XCTAssertFalse(media.disconnected)
      let opened = await control.openedCount()
      XCTAssertEqual(opened, 1)
      let delivery = UUID()
      await control.append(try event(session: session, sequence: 3, kind: "Final", fields: [
        "utteranceId": delivery.uuidString, "deliveryId": delivery.uuidString, "text": "new valid input"]))
      await settle { model.state.hasPendingAdmission }
      XCTAssertNil(model.state.inputNotice)
      await model.shutdown()
    }
  }

  func testRepeatNoticeRetainsThroughInterimAndClearsOnEndAndRestart() async throws {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    let model = VoiceViewModel(control: control, media: media) { _ in }
    model.start()
    await settle { model.state.capture == .listening }
    let session = await control.identity()
    let utterance = UUID()
    await control.append(
      try event(
        session: UUID(), sequence: 1, kind: "Error",
        fields: [
          "utteranceId": utterance.uuidString, "code": "RecognitionFailed", "message": "fixture",
        ]))
    await control.append(
      try event(
        session: session, sequence: 2, kind: "Interim",
        fields: ["utteranceId": utterance.uuidString, "text": "synthetic failed interim"]))
    await settle { model.state.tentative == "synthetic failed interim" }
    XCTAssertNil(model.state.unrecognizedUtterance)
    XCTAssertEqual(model.state.capture, .listening)
    await control.append(
      try event(
        session: session, sequence: 3, kind: "Error",
        fields: [
          "utteranceId": utterance.uuidString, "code": "RecognitionFailed", "message": "fixture",
        ]))
    await settle { model.state.unrecognizedUtterance == utterance }
    XCTAssertEqual(model.state.tentative, "")
    XCTAssertEqual(model.state.capture, .listening)
    await control.append(
      try event(
        session: session, sequence: 4, kind: "Interim",
        fields: ["utteranceId": UUID().uuidString, "text": "synthetic interim"]))
    await settle { model.state.tentative == "synthetic interim" }
    XCTAssertEqual(model.state.unrecognizedUtterance, utterance)
    model.end()
    await settle { model.state.capture == .ended }
    XCTAssertNil(model.state.unrecognizedUtterance)
    model.start()
    await settle { model.state.capture == .listening }
    XCTAssertNil(model.state.unrecognizedUtterance)
    await model.shutdown()
  }

  func testUnscopedRecognitionAndUnauthorizedErrorsFailCapture() async throws {
    let cases: [(Any, String)] = [
      (NSNull(), "RecognitionFailed"), (NSNull(), "InvalidRecognition"),
      (UUID().uuidString, "Unauthorized"),
    ]
    for (utterance, code) in cases {
      let control = FixtureControl()
      let media = FixtureMedia(allowed: true)
      let model = VoiceViewModel(control: control, media: media) { _ in }
      model.start()
      await settle { model.state.capture == .listening }
      let session = await control.identity()
      await control.append(
        try event(
          session: session, sequence: 1, kind: "Error",
          fields: ["utteranceId": utterance, "code": code, "message": "fixture"]))
      await settle { model.state.capture == .failed(.backend(code: code, message: "fixture")) }
      XCTAssertNil(model.state.unrecognizedUtterance)
      await settle { media.disconnected }
      await model.shutdown()
    }
  }

  func testUtteranceRecognitionFailureKeepsHealthySessionAndNextSpeechCanBeAccepted() async throws {
    for code in ["RecognitionFailed", "InvalidRecognition"] {
      for muted in [false, true] {
        let control = FixtureControl()
        let media = FixtureMedia(allowed: true)
        media.holdOutput = false
        var receipts: [ConversationMessage] = []
        let model = VoiceViewModel(control: control, media: media) { receipts.append($0) }
        model.start()
        await settle { model.state.capture == .listening }
        if muted {
          model.toggleMute()
          await settle { model.state.capture == .muted }
        }
        let session = await control.identity()
        let priorResponse = UUID()
        let priorInput = UUID()
        let priorEpoch = UUID()
        await control.append(
          try event(
            session: session, sequence: 1, kind: "Output",
            fields: [
              "output": [
                "responseId": priorResponse.uuidString, "inputDeliveryId": priorInput.uuidString,
                "outputEpoch": priorEpoch.uuidString, "status": "Preparing", "manifest": NSNull(),
                "error": NSNull(),
              ]
            ]))
        await settle { model.output.current?.responseId == priorResponse }
        let stops = media.stoppedOutput
        let failedUtterance = UUID()
        await control.append(
          try event(
            session: session, sequence: 2, kind: "Error",
            fields: [
              "utteranceId": failedUtterance.uuidString, "code": code,
              "message": "synthetic recognition failure",
            ]))
        await settle { model.state.sequence >= 2 }
        let expected: VoiceState.Capture = muted ? .muted : .listening
        XCTAssertEqual(
          model.state.capture, expected, "An utterance failure must not end a healthy session")
        guard model.state.capture == expected else {
          await model.shutdown()
          return
        }
        XCTAssertEqual(model.state.sessionId, session)
        XCTAssertEqual(model.state.unrecognizedUtterance, failedUtterance)
        XCTAssertFalse(media.disconnected)
        XCTAssertEqual(media.stoppedOutput, stops)
        XCTAssertFalse(model.output.locallyInterrupted)
        XCTAssertTrue(receipts.isEmpty)
        XCTAssertTrue(model.state.admissions.isEmpty)
        let ended = await control.wasEnded()
        let opened = await control.openedCount()
        XCTAssertFalse(ended)
        XCTAssertEqual(opened, 1)
        let delivery = UUID()
        await control.append(
          try event(
            session: session, sequence: 3, kind: "Final",
            fields: [
              "utteranceId": delivery.uuidString, "deliveryId": delivery.uuidString,
              "text": "synthetic next speech",
            ]))
        await settle { model.state.hasPendingAdmission }
        XCTAssertNil(model.state.unrecognizedUtterance)
        let receipt = ConversationMessage(
          deliveryId: delivery, recordId: 1, position: 1, text: "synthetic next speech")
        await control.append(
          try event(
            session: session, sequence: 4, kind: "Accepted",
            fields: [
              "utteranceId": delivery.uuidString,
              "receipt": try JSONSerialization.jsonObject(with: JSONEncoder().encode(receipt)),
            ]))
        await settle { receipts == [receipt] }
        let reply = UUID()
        await control.append(
          try event(
            session: session, sequence: 5, kind: "Output",
            fields: [
              "output": outputValue(
                session: session, input: delivery, response: reply, epoch: UUID())
            ]))
        await settle { model.output.current?.responseId == reply && media.preparedOutputs == 1 }
        XCTAssertEqual(model.state.capture, expected)
        XCTAssertEqual(model.state.sessionId, session)
        await model.shutdown()
      }
    }
  }

  #if DEBUG
    func testBackendFailureBeforeAnyReplyPersistsSanitizedCause() async throws {
      let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
      VoiceTransitionTrace.shared.configure(destination: file)
      defer {
        VoiceTransitionTrace.shared.configure(destination: nil)
        VoiceTransitionTrace.shared.flush()
        try? FileManager.default.removeItem(at: file)
      }
      let control = FixtureControl()
      let model = VoiceViewModel(control: control, media: FixtureMedia(allowed: true)) { _ in }
      model.start()
      await settle { model.state.capture == .listening }
      let session = await control.identity()
      await control.append(
        try event(
          session: session, sequence: 1, kind: "Error",
          fields: [
            "utteranceId": NSNull(), "code": "RecognitionFailed",
            "message": "synthetic private detail",
          ]))
      await settle {
        if case .failed = model.state.capture { return true }
        return false
      }
      let events = VoiceTransitionTrace.shared.snapshot.events
      let wire = try XCTUnwrap(events.last { $0.cause == .wireError })
      XCTAssertEqual(wire.failureKind, "Backend")
      XCTAssertEqual(wire.backendCode, "RecognitionFailed")
      XCTAssertNil(wire.response)
      XCTAssertEqual(wire.session, VoiceTransitionTrace.hash(session))
      XCTAssertTrue(
        events.contains { $0.cause == .transportFailed && $0.backendCode == "RecognitionFailed" })
      VoiceTransitionTrace.shared.record(
        .failure, failure: .backend(code: "untrusted private code", message: "private"))
      VoiceTransitionTrace.shared.flush()
      let persisted = try String(contentsOf: file, encoding: .utf8)
      XCTAssertFalse(persisted.contains("private"))
      XCTAssertEqual(
        VoiceTransitionTrace.shared.snapshot.events.last?.backendCode, "OtherBackendCode")
      XCTAssertEqual(VoiceFailure.invalidResponse.traceKind, "InvalidResponse")
      XCTAssertEqual(VoiceFailure.checkpointUnavailable.traceKind, "CheckpointUnavailable")
      await model.shutdown()
    }
  #endif

  func testClassifiedNonSpeechPreservesWaitingReplyAndQualifiedSpeechInterrupts() async throws {
    #if DEBUG
      let traceFile = FileManager.default.temporaryDirectory.appendingPathComponent(
        UUID().uuidString)
      VoiceTransitionTrace.shared.configure(destination: traceFile)
      defer {
        VoiceTransitionTrace.shared.configure(destination: nil)
        VoiceTransitionTrace.shared.flush()
        try? FileManager.default.removeItem(at: traceFile)
      }
    #endif
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
    #if DEBUG
      let events = VoiceTransitionTrace.shared.snapshot.events
      let speech = try XCTUnwrap(events.lastIndex(where: { $0.cause == .speech }))
      let cut = try XCTUnwrap(events.lastIndex(where: { $0.cause == .cut }))
      XCTAssertLessThan(speech, cut)
      XCTAssertEqual(events[cut].response, VoiceTransitionTrace.hash(response))
      XCTAssertEqual(events[cut].outputEpoch, VoiceTransitionTrace.hash(epoch))
      XCTAssertTrue(
        events.contains { $0.cause == .onset && $0.capturedAt != nil && $0.classifiedAt != nil })
    #endif
    await capture.stop()
    notices.continuation.finish()
    await projection.value
    #if DEBUG
      let droppedBeforeReplay = VoiceTransitionTrace.shared.snapshot.dropped
      var terminal = preparing
      terminal["status"] = "Interrupted"
      for sequence in 2...145 {
        await control.append(
          try event(
            session: session, sequence: sequence, kind: "Output", fields: ["output": terminal]))
      }
      await settle { model.state.sequence >= 145 }
      XCTAssertGreaterThanOrEqual(model.state.sequence, 145)
      XCTAssertEqual(VoiceTransitionTrace.shared.snapshot.dropped, droppedBeforeReplay)
      XCTAssertTrue(VoiceTransitionTrace.shared.snapshot.events.contains { $0.cause == .speech })
    #endif
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
  var preparationChanges: [Bool] = []
  let captureDevice = VendorCaptureDevice()
  private lazy var captureLifetime = VoiceCaptureLifetimeDriver(device: captureDevice)
  var recordingPrepared: Bool { captureDevice.prepared }
  var holdPreparation = false
  var preparationWaiting = false
  var holdPreparationRelease = false
  var preparationReleaseWaiting = false
  var preparationFailure: VoiceFailure?
  var releasePreparationFailure: VoiceFailure?
  var preparationThrownError: (any Error)?
  private var preparationGate: CheckedContinuation<Void, Never>?
  func setCaptureLifetime(_ enabled: Bool) async throws {
    preparationChanges.append(enabled)
    if enabled && holdPreparation {
      preparationWaiting = true
      await withCheckedContinuation { preparationGate = $0 }
    }
    if !enabled && holdPreparationRelease {
      preparationReleaseWaiting = true
      await withCheckedContinuation { preparationGate = $0 }
    }
    if enabled, let preparationFailure { throw preparationFailure }
    if enabled, let preparationThrownError { throw preparationThrownError }
    if !enabled, let releasePreparationFailure { throw releasePreparationFailure }
    try await captureLifetime.setEnabled(enabled)
  }
  func resolvePreparationRelease() {
    holdPreparationRelease = false
    preparationGate?.resume()
    preparationGate = nil
  }
  func resolvePreparation() {
    holdPreparation = false
    preparationGate?.resume()
    preparationGate = nil
  }
  var progressCues: [VoiceProgressCue] = []
  var cueCancellations = 0
  func playCue(_ cue: VoiceProgressCue) { progressCues.append(cue) }
  func cancelCue() { cueCancellations += 1 }

  var platform: (@MainActor @Sendable (VoicePlatformEvent) -> Void)?
  var platformRetired = false
  var captureFences = 0
  var captureFenced = false
  var unmutesAfterFence = 0
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
    captureFenced = true
    captureDevice.roomStopped()
    return Task {}
  }
  var holdStop = false
  var stopWaiting = false
  var stopContinuation: CheckedContinuation<Void, Never>?
  var received: (@Sendable (VoiceOutputIdentity) -> Void)?
  var holdOutput = true
  var preparedOutputs = 0
  var preparationsCompleted = 0
  var stopsCompleted = 0
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
  var muteInFlight = false
  var connectedDuringMute = false
  var holdConnect = false
  var connectWaiting = false
  var muted = false
  var joinMutes: [Bool] = []
  var disconnected = false
  var connectFailure: VoiceFailure?
  var muteFailure: VoiceFailure?
  var muteThrownError: (any Error)?
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
    connectedDuringMute = connectedDuringMute || muteInFlight
    joinMutes.append(initiallyMuted)
    if !initiallyMuted { captureDevice.roomStarted() }
    captureFenced = false
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
    if !muted && captureFenced { unmutesAfterFence += 1 }
    muteInFlight = true
    defer { muteInFlight = false }
    if let muteFailure { throw muteFailure }
    if let muteThrownError { throw muteThrownError }
    if holdMute {
      muteWaiting = true
      await withCheckedContinuation { muteContinuation = $0 }
    }
    try Task.checkCancellation()
    self.muted = muted
    muteWaiting = false
  }
  func resolveMute() {
    holdMute = false
    muteContinuation?.resume()
    muteContinuation = nil
  }
  func disconnect() async {
    captureDevice.roomStopped()
    disconnected = true
    if holdDisconnect {
      disconnectWaiting = true
      await withCheckedContinuation { disconnectContinuation = $0 }
    }
  }
  func prepareOutput(_ manifest: VoiceAudioManifest) async throws {
    preparedOutputs += 1
    defer { preparationsCompleted += 1 }
    outputWaiting = true
    if holdOutput { await withCheckedContinuation { outputContinuation = $0 } }
  }
  func stopOutput(preservingFailureCue: Bool) -> Task<Void, Never> {
    stoppedOutput += 1
    return Task {
      defer { stopsCompleted += 1 }
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

private enum FixtureEndFailure: Sendable {
  case connection
  case spontaneousCancellation
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
  func waitForBootstrap() async -> Bool {
    for _ in 0..<300 {
      if startGate != nil { return true }
      try? await Task.sleep(for: .milliseconds(10))
    }
    return false
  }
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
  private var readyFailure = false
  func resolveReady(failing: Bool = false) {
    readyFailure = failing
    holdReady = false
    readyContinuation?.resume()
    readyContinuation = nil
  }
  func interruptCalls() -> Int { interruptCount }
  private var readyCount = 0
  func readyCalls() -> Int { readyCount }
  func waitForReadiness(_ count: Int) async -> Bool {
    for _ in 0..<300 {
      if readyCount >= count { return true }
      try? await Task.sleep(for: .milliseconds(10))
    }
    return false
  }
  private var readyReturns = 0
  func waitForReadinessReturns(_ count: Int) async -> Bool {
    for _ in 0..<300 {
      if readyReturns >= count { return true }
      try? await Task.sleep(for: .milliseconds(10))
    }
    return false
  }
  func ready(sessionId: UUID, manifest: VoiceAudioManifest) async throws -> VoiceSnapshot {
    readyCount += 1
    defer { readyReturns += 1 }
    let held = holdReady
    holdReady = false
    if held {
      let heldPage = try await snapshot(sessionId: sessionId, after: 0)
      await withCheckedContinuation { readyContinuation = $0 }
      if readyFailure {
        readyFailure = false
        throw VoiceFailure.connection
      }
      return heldPage
    }
    return try await snapshot(sessionId: sessionId, after: 0)
  }
  private var interruptFailure: VoiceFailure?
  func failInterrupt(_ failure: VoiceFailure) { interruptFailure = failure }
  func interrupt(sessionId: UUID, target: VoiceOutputIdentity) async throws -> VoiceSnapshot {
    interruptCount += 1
    if let interruptFailure { throw interruptFailure }
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
  private var sealFailures = 0
  func failSeals(_ count: Int) { sealFailures = count }
  private var sealCount = 0
  func sealCalls() -> Int { sealCount }
  private var producerMissing = false
  private var producerClosure: (session: UUID, incarnation: UUID)?
  func setProducerClosure(session: UUID, incarnation: UUID) {
    producerClosure = (session, incarnation)
  }
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
    sealCount += 1
    if sealFailures > 0 { sealFailures -= 1; throw VoiceFailure.connection }
    if let producerClosure {
      return .producerUnavailable(
        sessionId: producerClosure.session, backendIncarnationId: producerClosure.incarnation)
    }
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
  private var nextEndFailure: FixtureEndFailure?
  private var holdEndRetry = false
  private var endGate: CheckedContinuation<Void, Never>?
  private var attemptedEnds: [UUID] = []
  private var acknowledgedEndRetry = false
  func failFirstEndAndHoldRetry(_ failure: FixtureEndFailure) {
    nextEndFailure = failure
    holdEndRetry = true
  }
  func endAttempts() -> [UUID] { attemptedEnds }
  func endRetryAcknowledged() -> Bool { acknowledgedEndRetry }
  func waitForEndRetry() async -> Bool {
    for _ in 0..<300 {
      if endGate != nil { return true }
      try? await Task.sleep(for: .milliseconds(10))
    }
    return false
  }
  func releaseEndRetry() {
    holdEndRetry = false
    endGate?.resume()
    endGate = nil
  }
  func end(sessionId: UUID) async throws {
    attemptedEnds.append(sessionId)
    if let failure = nextEndFailure {
      nextEndFailure = nil
      switch failure {
      case .connection: throw VoiceFailure.connection
      case .spontaneousCancellation: throw CancellationError()
      }
    }
    if holdEndRetry {
      await withCheckedContinuation { endGate = $0 }
      acknowledgedEndRetry = true
    }
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
    // Observation polling is independent of the manually advanced retry backoff.
    if milliseconds == 250 {
      try await SystemVoiceRetryClock().sleep(milliseconds: milliseconds)
      return
    }
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
    media.platform?(.routeChanged(privateOutputRemoved: false))
    XCTAssertEqual(model.state.capture, .muted)
    let fencesBeforeInterruption = media.captureFences
    media.platform?(.interrupted)
    XCTAssertEqual(model.state.capture, .paused)
    XCTAssertTrue(model.state.wantsListening)
    XCTAssertGreaterThan(media.captureFences, fencesBeforeInterruption)
    let fencesAfterInterruption = media.captureFences
    media.platform?(.servicesLost)
    media.platform?(.routeChanged(privateOutputRemoved: true))
    XCTAssertEqual(media.captureFences, fencesAfterInterruption)
    XCTAssertEqual(interruptedInputs.count, 1)
    XCTAssertTrue(model.state.wantsMuted)
    media.platform?(.servicesReset)
    media.platform?(.resumeRecommended(false))
    XCTAssertEqual(model.state.capture, .paused)
    XCTAssertTrue(model.state.canResume)
    let count = await control.openedCount()
    XCTAssertEqual(count, 1)
    model.resume()
    await settle { model.state.capture == .muted }
    XCTAssertEqual(media.joinMutes, [false, true])
    let retiredPlatform = media.platform
    model.end()
    await settle { model.state.capture == .ended }
    retiredPlatform?(.resumeRecommended(true))
    model.resume()
    XCTAssertEqual(model.state.capture, .ended)
    XCTAssertFalse(model.state.wantsListening)
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
  func testProducerClosureRequiresExactScopeAndPreservesUnknownAdmission() async throws {
    for wrongSession in [true, false] {
      let control = FixtureControl()
      let media = FixtureMedia(allowed: true)
      let checkpoint = VolatileVoiceAdmissionCheckpoint()
      let model = VoiceViewModel(control: control, media: media, checkpoint: checkpoint) { _ in }
      model.start()
      await settle { model.state.capture == .listening }
      let session = await control.identity()
      let incarnation = UUID(uuidString: "11111111-1111-4111-8111-111111111111")!
      let delivery = UUID()
      await control.append(
        try event(
          session: session, sequence: 1, kind: "Final",
          fields: [
            "utteranceId": delivery.uuidString, "deliveryId": delivery.uuidString,
            "text": "Handed speech",
          ]))
      await settle { model.state.hasPendingAdmission }
      let association = VoiceAdmissionAssociation(
        backendIncarnationId: incarnation, sessionId: session, deliveryId: delivery)
      for _ in 0..<300 {
        if await checkpoint.load() == [association] { break }
        try await Task.sleep(for: .milliseconds(10))
      }
      await control.setProducerClosure(
        session: wrongSession ? UUID() : session,
        incarnation: wrongSession ? incarnation : UUID())
      media.platform?(.interrupted)
      await settle { model.state.capture == .paused && media.disconnected }
      for _ in 0..<300 {
        if await control.sealCalls() == 1 { break }
        try await Task.sleep(for: .milliseconds(10))
      }
      XCTAssertTrue(model.state.hasPendingAdmission)
      let stillSaved = await checkpoint.load()
      XCTAssertEqual(stillSaved, [association])
      await control.setProducerClosure(session: session, incarnation: incarnation)
      model.resume()
      await settle { model.state.capture == .checkingPreviousSpeech }
      let sealCalls = await control.sealCalls()
      XCTAssertEqual(sealCalls, 2, "Wrong-scope closure must require fresh exact producer evidence")
      XCTAssertEqual(media.joinMutes, [false, true])
      XCTAssertTrue(model.state.hasPendingAdmission)
      let savedAfterRecovery = await checkpoint.load()
      XCTAssertEqual(savedAfterRecovery, [association])
      await model.shutdown()
    }
  }

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


private enum InterpreterPortDefect: Error { case syntheticPrivateDetail }

extension VoiceViewModelTests {
  func testInterpreterUnknownPortFailureDoesNotBecomeCancellationOrConnection() async {
    let media = FixtureMedia(allowed: true)
    media.muteThrownError = InterpreterPortDefect.syntheticPrivateDetail
    let result = await interpreted(.localMute(true), media: media)
    guard case .localMuted(.failure(let failure))? = result else {
      return XCTFail("Unknown port error must remain a typed operation failure")
    }
    XCTAssertEqual(failure, .unexpectedOperation)
  }

  func testAutomaticReconnectReopensFreshOutputWithoutLosingConnectingInputFence() async throws {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    media.holdOutput = false
    let clock = FixtureRetryClock()
    let model = VoiceViewModel(control: control, media: media, retryClock: clock) { _ in }
    model.start()
    await settle { model.state.capture == .listening }
    let oldSession = await control.identity()
    let oldInput = UUID()
    let oldResponse = UUID()
    let oldEpoch = UUID()
    let old = outputValue(
      session: oldSession, input: oldInput, response: oldResponse, epoch: oldEpoch)
    await control.append(
      try event(session: oldSession, sequence: 7, kind: "Output", fields: ["output": old]))
    await settle { media.preparedOutputs == 1 }
    let oldFailure = media.failure
    let oldAudio = media.received
    oldFailure?()
    await settle { model.state.capture == .hostUnavailable }
    XCTAssertTrue(model.output.closed)
    media.holdConnect = true
    await clock.advance()
    await settle { media.connectWaiting }
    let newInput = UUID()
    model.inputIntent(newInput)
    XCTAssertEqual(model.output.allowedInput, newInput)
    oldAudio?(VoiceOutputIdentity(
      inputDeliveryId: oldInput, responseId: oldResponse, outputEpoch: oldEpoch))
    oldFailure?()
    for _ in 0..<20 { await Task.yield() }
    XCTAssertTrue(model.output.closed, "Retired callbacks cannot reopen the held connection")
    XCTAssertFalse(model.output.receivedAudio)
    media.resolveConnect()
    await settle { model.state.capture == .listening }
    let newSession = await control.identity()
    XCTAssertNotEqual(newSession, oldSession)
    XCTAssertFalse(model.output.closed)
    XCTAssertEqual(model.output.allowedInput, newInput)
    XCTAssertTrue(model.output.gated)
    let denied = outputValue(session: newSession, input: UUID(), response: UUID(), epoch: UUID())
    await control.append(
      try event(session: newSession, sequence: 1, kind: "Output", fields: ["output": denied]))
    await settle { model.state.sequence >= 1 }
    XCTAssertEqual(media.preparedOutputs, 1, "Reconnect must preserve the connecting input fence")
    let freshResponse = UUID()
    let fresh = outputValue(
      session: newSession, input: newInput, response: freshResponse, epoch: UUID())
    await control.append(
      try event(session: newSession, sequence: 2, kind: "Output", fields: ["output": fresh]))
    await settle { media.preparedOutputs == 2 }
    XCTAssertEqual(model.output.current?.responseId, freshResponse)
    XCTAssertFalse(model.output.locallyInterrupted)
    XCTAssertEqual(model.output.sequence, 2, "Fresh origin sequences restart independently")
    await model.shutdown()
  }

  func testUnexpectedPortFailureStopsAutomaticCaptureRecoveryAndRemainsVisible() async {
    let control = FixtureControl()
    let media = FixtureMedia(allowed: true)
    let model = VoiceViewModel(control: control, media: media) { _ in }
    model.start()
    await settle { model.state.capture == .listening }
    media.muteThrownError = InterpreterPortDefect.syntheticPrivateDetail
    model.toggleMute()
    await settle { model.state.capture == .failed(.unexpectedOperation) }
    XCTAssertFalse(model.state.wantsListening)
    XCTAssertTrue(model.state.canStart)
    let opens = await control.openedCount()
    XCTAssertEqual(opens, 1)
    await model.shutdown()
  }

  func testInterpreterExpectedAndSpontaneousCancellationRemainTypedFailures() async {
    let expected = FixtureMedia(allowed: true)
    expected.muteFailure = .invalidResponse
    let expectedResult = await interpreted(.localMute(true), media: expected)
    guard case .localMuted(.failure(.invalidResponse))? = expectedResult else {
      return XCTFail("Expected failure must retain its domain value")
    }
    let spontaneous = FixtureMedia(allowed: true)
    spontaneous.muteThrownError = CancellationError()
    let spontaneousResult = await interpreted(.localMute(true), media: spontaneous)
    guard case .localMuted(.failure(.capture))? = spontaneousResult else {
      return XCTFail("A noncancelled port throwing CancellationError is a failed operation")
    }
  }

  func testInterpreterActualCancellationAcknowledgesItsOwnHeldWork() async {
    let media = FixtureMedia(allowed: true)
    media.holdMute = true
    let result = await interpreted(.localMute(true), media: media, cancelHeldMute: true)
    guard case .cancelled? = result else {
      return XCTFail("Intentional task cancellation must remain a cancellation acknowledgement")
    }
    XCTAssertFalse(media.muted)
  }

  func testInterpreterTimerFailuresNeverMasqueradeAsElapsedOrCancelled() async {
    for kind in [InterpreterFailureClock.Kind.expected, .unexpected, .spontaneousCancellation] {
      let result = await interpreted(
        .sleep(milliseconds: 1, purpose: .captureRetry), media: FixtureMedia(allowed: true),
        clock: InterpreterFailureClock(kind: kind))
      guard case .timerFailed(let failure)? = result else {
        return XCTFail("A failed noncancelled timer must not manufacture elapsed time")
      }
      switch kind {
      case .expected: XCTAssertEqual(failure, .invalidResponse)
      case .unexpected: XCTAssertEqual(failure, .unexpectedOperation)
      case .spontaneousCancellation: XCTAssertEqual(failure, .connection)
      }
    }
  }

  func testReplacementPreparationWaitsForOldPreparationAndPhysicalStopInEitherOrder() async throws {
    for releasePreparationFirst in [true, false] {
      let control = FixtureControl()
      let media = FixtureMedia(allowed: true)
      let model = VoiceViewModel(control: control, media: media) { _ in }
      model.start()
      await settle { model.state.capture == .listening }
      let session = await control.identity()
      let old = outputValue(session: session, input: UUID(), response: UUID(), epoch: UUID())
      await control.append(
        try event(session: session, sequence: 1, kind: "Output", fields: ["output": old]))
      await settle { media.outputContinuation != nil }
      let newInput = UUID()
      let newResponse = UUID()
      media.holdStop = true
      let stopsBeforeCut = media.stoppedOutput
      model.inputIntent(newInput)
      XCTAssertGreaterThan(media.stoppedOutput, stopsBeforeCut, "Revocation must be synchronous")
      XCTAssertTrue(model.output.locallyInterrupted)
      let replacement = outputValue(
        session: session, input: newInput, response: newResponse, epoch: UUID())
      await control.append(
        try event(session: session, sequence: 2, kind: "Output", fields: ["output": replacement]))
      await settle { media.stopWaiting && model.output.current?.responseId == newResponse }
      XCTAssertEqual(media.preparedOutputs, 1)
      media.holdOutput = false
      let stoppedBeforeRelease = media.stopsCompleted
      if releasePreparationFirst {
        media.resolveOutput()
        await settle { media.preparationsCompleted == 1 }
      } else {
        media.resolveStop()
        await settle { media.stopsCompleted > stoppedBeforeRelease }
      }
      XCTAssertEqual(media.preparedOutputs, 1, "Neither dependency alone authorizes replacement")
      if releasePreparationFirst { media.resolveStop() } else { media.resolveOutput() }
      await settle { media.preparedOutputs == 2 && model.output.prepared != nil }
      XCTAssertEqual(model.output.current?.responseId, newResponse)
      XCTAssertFalse(model.output.locallyInterrupted)
      let ready = await control.readyCalls()
      XCTAssertLessThanOrEqual(ready, 1, "Old cancelled preparation cannot publish readiness")
      await model.shutdown()
    }
  }

  #if DEBUG
    func testInterpreterInterruptFailureRetainsSanitizedDiagnosticReason() async throws {
      let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
      VoiceTransitionTrace.shared.configure(destination: file)
      defer {
        VoiceTransitionTrace.shared.configure(destination: nil)
        VoiceTransitionTrace.shared.flush()
        try? FileManager.default.removeItem(at: file)
      }
      let control = FixtureControl()
      await control.failInterrupt(.backend(code: "Unavailable", message: "private payload"))
      let target = VoiceOutputIdentity(inputDeliveryId: UUID(), responseId: UUID(), outputEpoch: UUID())
      let origin = VoiceOrigin(sessionId: UUID(), backendIncarnationId: UUID())
      let result = await interpreted(
        .interrupt(origin, target), media: FixtureMedia(allowed: true), control: control)
      guard case .interrupted(.failure(.backend("Unavailable", _)))? = result else {
        return XCTFail("Interrupt acknowledgement failure remains separate from canonical output")
      }
      let record = try XCTUnwrap(VoiceTransitionTrace.shared.snapshot.events.last {
        $0.cause == .interruptFailed && $0.outputEpoch == VoiceTransitionTrace.hash(target.outputEpoch)
      })
      XCTAssertEqual(record.failureKind, "Backend")
      XCTAssertEqual(record.backendCode, "Unavailable")
      XCTAssertEqual(VoiceFailure.unexpectedOperation.traceKind, "UnexpectedOperation")
      VoiceTransitionTrace.shared.flush()
      let persisted = try String(contentsOf: file, encoding: .utf8)
      XCTAssertFalse(persisted.contains("private payload"))
    }
  #endif

  private func interpreted(
    _ work: VoiceWork, media: FixtureMedia,
    clock: any VoiceRetryClock = SystemVoiceRetryClock(), cancelHeldMute: Bool = false,
    control: FixtureControl = FixtureControl()
  ) async -> VoiceWorkResult? {
    var result: VoiceWorkResult?
    let interpreter = VoiceTaskInterpreter(
      control: control, media: media, checkpoint: VolatileVoiceAdmissionCheckpoint(),
      clock: clock, receive: { event in
        if case .completed(_, let completed) = event { result = completed }
      }, accepted: { _ in XCTFail("No acceptance expected") }, refresh: {}, interrupt: { _, _ in })
    interpreter.execute(.run(VoiceRequest(generation: 1, id: 1), work, after: []))
    if cancelHeldMute {
      await settle { media.muteWaiting }
      interpreter.execute(.cancel([VoiceRequest(generation: 1, id: 1)]))
      media.resolveMute()
    }
    await interpreter.drain()
    return result
  }
}


private struct InterpreterFailureClock: VoiceRetryClock {
  enum Kind: Sendable { case expected, unexpected, spontaneousCancellation }
  let kind: Kind
  func sleep(milliseconds: Int) async throws {
    switch kind {
    case .expected: throw VoiceFailure.invalidResponse
    case .unexpected: throw InterpreterPortDefect.syntheticPrivateDetail
    case .spontaneousCancellation: throw CancellationError()
    }
  }
}
