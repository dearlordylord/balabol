import Foundation
import XCTest
import os

@MainActor
final class VoiceCaptureUITests: XCTestCase {
  func testRealSimulatorMicrophonePublishesMuteAndEnd() async throws {
    let app = try await launchVoiceFixture(test: self)
    defer { app.terminate() }
    app.buttons["start-voice"].tap()
    guard await handleMicrophonePermission(app, test: self) else { return }
    let status = app.staticTexts["voice-status"]
    let listening = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "label == %@", "Listening"), object: status)
    let publication = await XCTWaiter.fulfillment(of: [listening], timeout: 30)
    guard publication == .completed else {
      XCTFail("Microphone did not reach Listening: " + status.label)
      return
    }
    let mute = app.buttons["mute-voice"]
    XCTAssertTrue(mute.exists)
    mute.tap()
    let muted = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "label == %@", "Microphone muted"), object: status)
    let muteResult = await XCTWaiter.fulfillment(of: [muted], timeout: 10)
    XCTAssertEqual(muteResult, .completed)
    mute.tap()
    let unmuted = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "label == %@", "Listening"), object: status)
    let unmuteResult = await XCTWaiter.fulfillment(of: [unmuted], timeout: 10)
    XCTAssertEqual(unmuteResult, .completed)
    // XCTest can resolve a button, pause for SpringBoard checks, then tap its
    // obsolete coordinates after a reconnecting status wraps. Re-query only
    // until the actual intent is acknowledged, within the original deadline.
    let endDeadline = Date().addingTimeInterval(10)
    var endAcknowledged = false
    for _ in 0..<3 {
      guard endDeadline.timeIntervalSinceNow > 0 else { break }
      if ["Ending voice…", "Voice ended"].contains(status.label) {
        endAcknowledged = true
        break
      }
      let end = app.buttons["end-voice"]
      guard end.exists else { break }
      end.tap()
      let acknowledged = XCTNSPredicateExpectation(
        predicate: NSPredicate(format: "label IN %@", ["Ending voice…", "Voice ended"]),
        object: status)
      let acknowledgment = await XCTWaiter.fulfillment(
        of: [acknowledged], timeout: min(1, max(0, endDeadline.timeIntervalSinceNow)))
      if acknowledgment == .completed {
        endAcknowledged = true
        break
      }
    }
    XCTAssertTrue(endAcknowledged, "End intent was not acknowledged: " + status.label)
    let ended = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "label == %@", "Voice ended"), object: status)
    let endResult = await XCTWaiter.fulfillment(
      of: [ended], timeout: max(0, endDeadline.timeIntervalSinceNow))
    XCTAssertEqual(endResult, .completed, "End did not settle: " + status.label)
    XCTAssertTrue(app.textFields["message-draft"].isEnabled)
  }
  func testRealSDKFixtureAudioPlaysAndTextIntentInterruptsBeforeAnotherInput() async throws {
    let app = try await launchVoiceFixture(test: self)
    defer { app.terminate() }
    app.buttons["start-voice"].tap()
    guard await handleMicrophonePermission(app, test: self) else { return }
    let status = app.staticTexts["voice-status"]
    let listening = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "label == %@", "Listening"), object: status)
    let connected = await XCTWaiter.fulfillment(of: [listening], timeout: 30)
    guard connected == .completed else {
      XCTFail("Real microphone publication failed")
      return
    }
    // Prevent the acoustic fixture from feeding the microphone during this
    // output-only check. Text intent still goes through the real conversation.
    app.buttons["mute-voice"].tap()
    let muted = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "label == %@", "Microphone muted"), object: status)
    let muteResult = await XCTWaiter.fulfillment(of: [muted], timeout: 10)
    XCTAssertEqual(muteResult, .completed)
    let draft = app.textFields["message-draft"]
    draft.tap()
    draft.typeText("Fixture audio " + UUID().uuidString)
    app.buttons["send-message"].tap()
    // Playing requires both the authoritative Playing status and nonzero PCM
    // from the exact subscribed SDK remote track. No test injects audio here.
    XCTAssertTrue(app.staticTexts["voice-output-playing"].waitForExistence(timeout: 20))
    let prior = try await currentVoiceFixtureTurn()
    draft.tap()
    draft.typeText("Cut")
    app.buttons["send-message"].tap()
    // The local label is provisional and may already be replaced by the next
    // response. Assert the exact prior response's durable interruption instead.
    let interrupted = try await terminalVoiceFixtureReply(input: prior.input.deliveryId)
    XCTAssertEqual(interrupted.responseId, prior.reply?.responseId)
    XCTAssertEqual(interrupted.state, "Interrupted")
    let position = try XCTUnwrap(interrupted.receipt?.position)
    app.buttons["end-voice"].tap()
    let ended = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "label == %@", "Voice ended"), object: status)
    let endResult = await XCTWaiter.fulfillment(of: [ended], timeout: 10)
    XCTAssertEqual(endResult, .completed)
    let visible = await revealInterruptedReceipt(app, position: position, test: self)
    XCTAssertTrue(visible)
  }

  func testRealSDKAcousticOnsetInterruptsPlayingBeforeRecognitionFinal() async throws {
    let app = try await launchVoiceFixture(test: self)
    defer { app.terminate() }
    app.buttons["start-voice"].tap()
    guard await handleMicrophonePermission(app, test: self) else { return }
    let status = app.staticTexts["voice-status"]
    let listening = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "label == %@", "Listening"), object: status)
    let connected = await XCTWaiter.fulfillment(of: [listening], timeout: 30)
    guard connected == .completed else {
      XCTFail("Real microphone publication failed")
      return
    }
    let draft = app.textFields["message-draft"]
    let text = "Acoustic interruption " + UUID().uuidString
    draft.tap()
    draft.typeText(text)
    app.buttons["send-message"].tap()
    let playing = app.staticTexts["voice-output-playing"]
    guard playing.waitForExistence(timeout: 20) else {
      XCTFail("Actual fixture PCM did not play with the microphone live")
      return
    }
    // Keep capture live while PCM plays. Echo must not silently interrupt the
    // response before the external acoustic fixture has been requested.
    try await Task.sleep(for: .milliseconds(300))
    XCTAssertEqual(status.label, "Listening")
    guard playing.exists else {
      XCTFail("Playback self-interrupted before acoustic stimulus")
      return
    }
    let prior = try await currentVoiceFixtureTurn()
    XCTAssertEqual(prior.input.text, text)
    XCTAssertFalse(app.staticTexts["voice-saving"].exists)
    XCTAssertFalse(app.staticTexts["voice-saved"].exists)
    let response = try XCTUnwrap(prior.reply?.responseId)
    let logger = os.Logger(subsystem: "app.balabol.voice.evidence", category: "acoustic-sync")
    logger.notice("acoustic ready response=\(response.uuidString, privacy: .public)")
    // The runner starts a bounded external speaker stimulus upon the marker.
    // This test never supplies PCM to LiveKit, recognition, or the application.
    let interrupted = try await terminalVoiceFixtureReply(input: prior.input.deliveryId)
    XCTAssertEqual(interrupted.responseId, response)
    guard interrupted.state == "Interrupted" else {
      XCTFail("Acoustic onset did not interrupt the exact Playing response")
      return
    }
    let beforeFinal = try await currentVoiceFixtureTurn()
    XCTAssertEqual(beforeFinal.input.deliveryId, prior.input.deliveryId)
    XCTAssertFalse(app.staticTexts["voice-output-playing"].exists)
    XCTAssertFalse(app.staticTexts["voice-saving"].exists)
    XCTAssertFalse(app.staticTexts["voice-saved"].exists)
    logger.notice(
      "acoustic interruption observed before final response=\(response.uuidString, privacy: .public)"
    )
    guard app.staticTexts["voice-saved"].waitForExistence(timeout: 20) else {
      XCTFail("Actual microphone recognition did not subsequently reach durable admission")
      return
    }
    let accepted = try await currentVoiceFixtureTurn()
    XCTAssertNotEqual(accepted.input.deliveryId, prior.input.deliveryId)
    // XCTest exposes this empty native TextField through its placeholder value.
    // Nonempty draft preservation is exercised by the separate microphone test.
    XCTAssertEqual(draft.value as? String, draft.placeholderValue)
    app.buttons["end-voice"].tap()
    let ended = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "label == %@", "Voice ended"), object: status)
    let endResult = await XCTWaiter.fulfillment(of: [ended], timeout: 10)
    XCTAssertEqual(endResult, .completed)
    let position = try XCTUnwrap(interrupted.receipt?.position)
    let visible = await revealInterruptedReceipt(app, position: position, test: self)
    XCTAssertTrue(visible)
  }

  func testRealSDKBackendRestartPreservesMutedIntentDraftAndInterruptedReceipt() async throws {
    let app = try await launchVoiceFixture(test: self)
    defer { app.terminate() }
    app.buttons["start-voice"].tap()
    guard await handleMicrophonePermission(app, test: self) else { return }
    let status = app.staticTexts["voice-status"]
    let listening = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "label == %@", "Listening"), object: status)
    guard await XCTWaiter.fulfillment(of: [listening], timeout: 30) == .completed else {
      XCTFail("Real SDK microphone did not publish before restart test")
      return
    }
    app.buttons["mute-voice"].tap()
    let muted = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "label == %@", "Microphone muted"), object: status)
    guard await XCTWaiter.fulfillment(of: [muted], timeout: 10) == .completed else {
      XCTFail("Capture must be muted before fixture playback")
      return
    }
    let draft = app.textFields["message-draft"]
    let suffix = String(UUID().uuidString.prefix(8))
    let sent = "Restart fixture " + suffix
    let unsent = "Keep " + suffix
    draft.tap()
    draft.typeText(sent)
    app.buttons["send-message"].tap()
    let playing = app.staticTexts["voice-output-playing"]
    guard playing.waitForExistence(timeout: 20) else {
      XCTFail("Real subscribed SDK fixture PCM did not reach Playing")
      return
    }
    let prior = try await currentVoiceFixtureTurn()
    XCTAssertEqual(prior.input.text, sent)
    let response = try XCTUnwrap(prior.reply?.responseId)
    draft.tap()
    draft.typeText(unsent)
    XCTAssertEqual(draft.value as? String, unsent)
    XCTAssertEqual(status.label, "Microphone muted")
    guard playing.exists else {
      XCTFail("Fixture playback ended before the controlled restart marker")
      return
    }
    let logger = os.Logger(subsystem: "app.balabol.voice.evidence", category: "restart-sync")
    logger.notice(
      "backend restart ready response=\(response.uuidString, privacy: .public) input=\(prior.input.deliveryId.uuidString, privacy: .public)"
    )
    // The external driver retires only its owned backend listener, waits four
    // seconds, and restarts the same fixture database. No source or audio is injected.
    let reconnecting = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "label CONTAINS[c] %@", "reconnect"), object: status)
    guard await XCTWaiter.fulfillment(of: [reconnecting], timeout: 20) == .completed else {
      XCTFail("Backend outage did not enter the owned reconnect lifecycle")
      return
    }
    XCTAssertEqual(draft.value as? String, unsent)
    XCTAssertFalse(playing.exists)
    let restoredMute = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "label == %@", "Microphone muted"), object: status)
    guard await XCTWaiter.fulfillment(of: [restoredMute], timeout: 45) == .completed else {
      XCTFail("Fresh SDK room did not restore muted user intent: " + status.label)
      return
    }
    XCTAssertEqual(app.buttons["mute-voice"].label, "Unmute")
    XCTAssertEqual(draft.value as? String, unsent)
    XCTAssertFalse(playing.exists)
    logger.notice("backend restart reconnected response=\(response.uuidString, privacy: .public)")
    try await Task.sleep(for: .milliseconds(750))
    XCTAssertEqual(status.label, "Microphone muted")
    XCTAssertFalse(playing.exists)
    // Existing INFO control-route evidence identifies distinct old/new room
    // sessions; the UI exposes intent and actual connection, never capabilities.
    let interrupted = try await terminalVoiceFixtureReply(input: prior.input.deliveryId)
    XCTAssertEqual(interrupted.responseId, response)
    XCTAssertEqual(interrupted.state, "Interrupted")
    let receipt = try XCTUnwrap(interrupted.receipt)
    XCTAssertEqual(receipt.deliveryId, response)
    XCTAssertEqual(receipt.responseId, response)
    XCTAssertEqual(receipt.inputDeliveryId, prior.input.deliveryId)
    XCTAssertEqual(receipt.role, "assistant")
    XCTAssertEqual(receipt.outcome, "interrupted")
    let current = try await currentVoiceFixtureTurn()
    XCTAssertEqual(current.input.deliveryId, prior.input.deliveryId)
    let tail = try await voiceFixtureHistory(after: prior.input.position)
    XCTAssertNil(tail.nextAfter)
    XCTAssertEqual(tail.messages.filter { $0.role == "user" }.count, 0)
    XCTAssertEqual(tail.messages.filter { $0.deliveryId == response }.count, 1)
    app.buttons["end-voice"].tap()
    let ended = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "label == %@", "Voice ended"), object: status)
    let endResult = await XCTWaiter.fulfillment(of: [ended], timeout: 10)
    XCTAssertEqual(endResult, .completed)
    XCTAssertEqual(draft.value as? String, unsent)
    let visibleBeforeRelaunch = await revealInterruptedReceipt(
      app, position: receipt.position, test: self)
    XCTAssertTrue(visibleBeforeRelaunch)
    XCTAssertEqual(app.staticTexts["assistant-message-\(receipt.position)"].label, receipt.text)
    app.terminate()
    app.launch()
    let restoredDraft = app.textFields["message-draft"]
    let draftRestored = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "value == %@", unsent), object: restoredDraft)
    let draftResult = await XCTWaiter.fulfillment(of: [draftRestored], timeout: 10)
    XCTAssertEqual(draftResult, .completed)
    XCTAssertEqual(restoredDraft.value as? String, unsent)
    XCTAssertEqual(app.staticTexts["voice-status"].label, "Voice is off")
    XCTAssertFalse(app.staticTexts["voice-output-playing"].exists)
    let visibleAfterRelaunch = await revealInterruptedReceipt(
      app, position: receipt.position, test: self)
    XCTAssertTrue(visibleAfterRelaunch)
    XCTAssertEqual(app.staticTexts["assistant-message-\(receipt.position)"].label, receipt.text)
    let relaunched = try await currentVoiceFixtureTurn()
    XCTAssertEqual(relaunched.input.deliveryId, prior.input.deliveryId)
    logger.notice("backend restart durable proof response=\(response.uuidString, privacy: .public)")
  }

  func testRealSDKSilentMicrophoneBaselineCreatesNoAcceptedInputFor60Seconds() async throws {
    let app = try await launchVoiceFixture(test: self)
    defer {
      if app.buttons["end-voice"].exists {
        app.buttons["end-voice"].tap()
        _ = app.buttons["start-voice"].waitForExistence(timeout: 3)
      }
      app.terminate()
    }
    guard try await currentVoiceFixtureTurnIfAny() == nil else {
      XCTFail("Silent baseline requires an empty isolated fixture database")
      return
    }
    app.buttons["start-voice"].tap()
    guard await handleMicrophonePermission(app, test: self) else { return }
    let status = app.staticTexts["voice-status"]
    let listening = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "label == %@", "Listening"), object: status)
    guard await XCTWaiter.fulfillment(of: [listening], timeout: 30) == .completed else {
      XCTFail("Actual SDK microphone publication failed")
      return
    }
    let logger = os.Logger(subsystem: "app.balabol.voice.evidence", category: "language-sync")
    logger.notice(
      "silent baseline microphone connected utc=\(Date.now.formatted(.iso8601), privacy: .public)")
    let deadline = ContinuousClock.now.advanced(by: .seconds(60))
    while ContinuousClock.now < deadline {
      if let current = try await currentVoiceFixtureTurnIfAny() {
        logger.notice(
          "silent baseline unexpected input=\(current.input.deliveryId.uuidString, privacy: .public) utc=\(Date.now.formatted(.iso8601), privacy: .public)"
        )
        XCTFail("Microphone admitted an input without any controlled external stimulus")
        return
      }
      try await Task.sleep(for: .milliseconds(200))
    }
    XCTAssertEqual(status.label, "Listening")
    logger.notice("silent baseline no accepted input seconds=60")
  }

  func testRealSDKSingleAcousticWaveDoesNotCreateInputsFromFixturePlayback() async throws {
    try await singleAcousticWave(restoreDraftFocus: false)
  }

  func testRealSDKSingleAcousticWaveWithIndependentDraftFocus() async throws {
    try await singleAcousticWave(restoreDraftFocus: true)
  }

  private func singleAcousticWave(restoreDraftFocus: Bool) async throws {
    let app = try await launchVoiceFixture(test: self)
    defer {
      if app.buttons["end-voice"].exists {
        app.buttons["end-voice"].tap()
        _ = app.buttons["start-voice"].waitForExistence(timeout: 3)
      }
      app.terminate()
    }
    if restoreDraftFocus {
      let draft = app.textFields["message-draft"]
      draft.tap()
      draft.typeText("Language draft " + String(UUID().uuidString.prefix(8)))
    }
    app.buttons["start-voice"].tap()
    guard await handleMicrophonePermission(app, test: self) else { return }
    let status = app.staticTexts["voice-status"]
    let listening = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "label == %@", "Listening"), object: status)
    guard await XCTWaiter.fulfillment(of: [listening], timeout: 30) == .completed else {
      XCTFail("Actual SDK microphone publication failed")
      return
    }
    let previous = try await currentVoiceFixtureTurnIfAny()?.input.deliveryId
    let logger = os.Logger(subsystem: "app.balabol.voice.evidence", category: "language-sync")
    logger.notice("multilingual acoustic ready ordinal=1")
    let first = try await nextVoiceFixtureTurn(after: previous)
    let input = first.input
    logger.notice(
      "single wave accepted input=\(input.deliveryId.uuidString, privacy: .public) position=\(input.position, privacy: .public)"
    )
    // Bind the reply to the first accepted input, never to a later current turn.
    // Stop immediately on a second accepted user input: scrolling and later
    // fixture ordinals are unrelated to this minimal feedback-loop symptom.
    let deadline = ContinuousClock.now.advanced(by: .seconds(8))
    var sawPlaying = false
    var completedAt: ContinuousClock.Instant?
    while ContinuousClock.now < deadline {
      let tail = try await voiceFixtureHistory(after: input.position)
      let reply = try await voiceFixtureReply(input: input.deliveryId)
      if let extra = tail.messages.first(where: { $0.role == "user" }) {
        logger.notice(
          "single wave extra input=\(extra.deliveryId.uuidString, privacy: .public) prior=\(input.deliveryId.uuidString, privacy: .public) replyState=\(reply.state, privacy: .public)"
        )
        XCTFail(
          "One external acoustic wave produced another accepted user input during its fixture reply"
        )
        return
      }
      if ["Interrupted", "Failed"].contains(reply.state) {
        logger.notice(
          "single wave premature terminal input=\(input.deliveryId.uuidString, privacy: .public) replyState=\(reply.state, privacy: .public)"
        )
        XCTFail("The exact first acoustic input's reply did not finish without interruption")
        return
      }
      sawPlaying = sawPlaying || app.staticTexts["voice-output-playing"].exists
      if reply.state == "Completed" {
        completedAt = completedAt ?? ContinuousClock.now
        if let completedAt, completedAt.duration(to: .now) >= .milliseconds(750) {
          XCTAssertTrue(sawPlaying, "Real subscribed SDK PCM must play during the minimal loop")
          XCTAssertEqual(status.label, "Listening")
          logger.notice(
            "single wave no extra input proof input=\(input.deliveryId.uuidString, privacy: .public)"
          )
          return
        }
      }
      try await Task.sleep(for: .milliseconds(200))
    }
    XCTFail("Exact first-input fixture playback did not complete within the bounded loop")
  }

  func testRealSDKScriptedLanguagesSwitchWithinOneVoiceSession() async throws {
    let app = try await launchVoiceFixture(test: self)
    defer {
      if app.buttons["end-voice"].exists {
        app.buttons["end-voice"].tap()
        _ = app.buttons["start-voice"].waitForExistence(timeout: 3)
      }
      app.terminate()
    }
    let capabilities = app.staticTexts["voice-languages"]
    XCTAssertTrue(capabilities.waitForExistence(timeout: 10))
    XCTAssertEqual(
      capabilities.label, "Scripted languages: " + fixtureLanguageNames(["ru", "fr", "en"]))
    let draft = app.textFields["message-draft"]
    let unsent = "Language draft " + String(UUID().uuidString.prefix(8))
    draft.tap()
    draft.typeText(unsent)
    app.buttons["start-voice"].tap()
    guard await handleMicrophonePermission(app, test: self) else { return }
    let status = app.staticTexts["voice-status"]
    let listening = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "label == %@", "Listening"), object: status)
    guard await XCTWaiter.fulfillment(of: [listening], timeout: 30) == .completed else {
      XCTFail("Actual SDK microphone publication failed")
      return
    }
    let texts = ["Привет", "Bonjour", "Hello", "Bonjour Hello"]
    let expectedSpans = [
      [VoiceFixtureLanguageSpan(language: "ru", start: 0, end: 6)],
      [VoiceFixtureLanguageSpan(language: "fr", start: 0, end: 7)],
      [VoiceFixtureLanguageSpan(language: "en", start: 0, end: 5)],
      [
        VoiceFixtureLanguageSpan(language: "fr", start: 0, end: 7),
        VoiceFixtureLanguageSpan(language: "en", start: 8, end: 13),
      ],
    ]
    var previousInput = try await currentVoiceFixtureTurnIfAny()?.input.deliveryId
    var acceptedIds: Set<UUID> = []
    var finalReceipt: VoiceFixtureReply.Receipt?
    let logger = os.Logger(subsystem: "app.balabol.voice.evidence", category: "language-sync")
    for ordinal in 1...4 {
      XCTAssertEqual(status.label, "Listening")
      XCTAssertFalse(app.staticTexts["voice-output-playing"].exists)
      logger.notice("multilingual acoustic ready ordinal=\(ordinal, privacy: .public)")
      // The external runner plays one bounded acoustic WAV on each marker.
      // The platform microphone and real SDK carry every utterance; the text
      // and annotations below are deterministic fake-recognition declarations.
      let accepted = try await nextVoiceFixtureTurn(after: previousInput)
      let input = accepted.input
      guard input.text == texts[ordinal - 1], input.languageSpans == expectedSpans[ordinal - 1],
        acceptedIds.insert(input.deliveryId).inserted
      else {
        logger.notice(
          "multilingual unexpected first input ordinal=\(ordinal, privacy: .public) input=\(input.deliveryId.uuidString, privacy: .public)"
        )
        XCTFail("Unexpected scripted input identity or language metadata")
        return
      }
      previousInput = input.deliveryId
      XCTAssertEqual(draft.value as? String, unsent)
      let playing = app.staticTexts["voice-output-playing"]
      guard
        let terminal = try await uninterruptedVoiceFixtureReply(
          input: input.deliveryId,
          playing: playing, ordinal: ordinal, logger: logger)
      else { return }
      let response = terminal.responseId
      let receipt = try XCTUnwrap(terminal.receipt)
      XCTAssertEqual(receipt.deliveryId, response)
      XCTAssertEqual(receipt.inputDeliveryId, input.deliveryId)
      XCTAssertEqual(receipt.outcome, "completed")
      let replySpans = try XCTUnwrap(terminal.languageSpans)
      XCTAssertFalse(replySpans.isEmpty)
      XCTAssertEqual(receipt.languageSpans, replySpans)
      XCTAssertEqual(draft.value as? String, unsent)
      let stopped = XCTNSPredicateExpectation(
        predicate: NSPredicate(format: "exists == false"), object: playing)
      let stopResult = await XCTWaiter.fulfillment(of: [stopped], timeout: 10)
      XCTAssertEqual(stopResult, .completed)
      let inputVisible = await revealLanguageReceipt(
        app, position: input.position, assistant: false)
      guard inputVisible else {
        XCTFail("Annotated input row is not visible")
        return
      }
      XCTAssertEqual(app.staticTexts["message-\(input.position)"].label, input.text)
      XCTAssertEqual(
        app.staticTexts["message-languages-\(input.position)"].label,
        fixtureLanguageNames(expectedSpans[ordinal - 1].map(\.language)))
      let outputVisible = await revealLanguageReceipt(
        app, position: receipt.position, assistant: true)
      guard outputVisible else {
        XCTFail("Annotated reply row is not visible")
        return
      }
      XCTAssertEqual(app.staticTexts["assistant-message-\(receipt.position)"].label, receipt.text)
      XCTAssertEqual(
        app.staticTexts["message-languages-\(receipt.position)"].label,
        fixtureLanguageNames(replySpans.map(\.language)))
      finalReceipt = receipt
      logger.notice(
        "multilingual durable audio observed ordinal=\(ordinal, privacy: .public) input=\(input.deliveryId.uuidString, privacy: .public) response=\(response.uuidString, privacy: .public)"
      )
      try await Task.sleep(for: .milliseconds(800))
      let quietTail = try await voiceFixtureHistory(after: input.position)
      if let extra = quietTail.messages.first(where: { $0.role == "user" }) {
        logger.notice(
          "multilingual extra input after completed ordinal=\(ordinal, privacy: .public) input=\(extra.deliveryId.uuidString, privacy: .public) prior=\(input.deliveryId.uuidString, privacy: .public)"
        )
        XCTFail("Unexpected accepted input between controlled acoustic waves")
        return
      }
    }
    XCTAssertEqual(acceptedIds.count, 4)
    XCTAssertEqual(status.label, "Listening")
    XCTAssertEqual(draft.value as? String, unsent)
    app.buttons["end-voice"].tap()
    let ended = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "label == %@", "Voice ended"), object: status)
    let endResult = await XCTWaiter.fulfillment(of: [ended], timeout: 10)
    XCTAssertEqual(endResult, .completed)
    app.terminate()
    app.launch()
    let restoredDraft = app.textFields["message-draft"]
    let restored = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "value == %@", unsent), object: restoredDraft)
    let draftResult = await XCTWaiter.fulfillment(of: [restored], timeout: 10)
    XCTAssertEqual(draftResult, .completed)
    XCTAssertEqual(app.staticTexts["voice-status"].label, "Voice is off")
    let receipt = try XCTUnwrap(finalReceipt)
    let persisted = await revealLanguageReceipt(app, position: receipt.position, assistant: true)
    XCTAssertTrue(persisted)
    XCTAssertEqual(
      app.staticTexts["message-languages-\(receipt.position)"].label,
      fixtureLanguageNames(try XCTUnwrap(receipt.languageSpans).map(\.language)))
    logger.notice("multilingual relaunch proof inputs=4")
  }

  func testActualMicrophoneUtteranceIsSavedWithoutChangingDraftAndSurvivesRelaunch() async throws {
    let app = try await launchVoiceFixture(test: self)
    defer { app.terminate() }
    let draft = app.textFields["message-draft"]
    let unsent = "Independent text draft " + UUID().uuidString
    draft.tap()
    draft.typeText(unsent)
    app.buttons["start-voice"].tap()
    guard await handleMicrophonePermission(app, test: self) else { return }
    let status = app.staticTexts["voice-status"]
    let listening = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "label == %@", "Listening"), object: status)
    let publication = await XCTWaiter.fulfillment(of: [listening], timeout: 30)
    guard publication == .completed else {
      XCTFail("Microphone did not reach Listening: " + status.label)
      return
    }
    // A bounded acoustic stimulus reaches the platform microphone. This test
    // never supplies PCM to the SDK or backend and installs no speech provider.
    let saved = app.staticTexts["voice-saved"]
    guard saved.waitForExistence(timeout: 20) else {
      XCTFail("No durable voice acceptance from actual microphone input")
      return
    }
    let session = URLSession(configuration: .ephemeral)
    defer { session.invalidateAndCancel() }
    let (data, response) = try await session.data(
      from: try voiceFixtureControlURL().appendingPathComponent("conversation/current"))
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    let receipt = try JSONDecoder().decode(VoiceFixtureCurrent.self, from: data).input
    let message = app.staticTexts["message-\(receipt.position)"]
    XCTAssertTrue(message.waitForExistence(timeout: 5))
    XCTAssertEqual(message.label, receipt.text)
    XCTAssertEqual(draft.value as? String, unsent)
    app.buttons["end-voice"].tap()
    let ended = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "label == %@", "Voice ended"), object: status)
    let outcome = await XCTWaiter.fulfillment(of: [ended], timeout: 10)
    XCTAssertEqual(outcome, .completed)
    XCTAssertEqual(draft.value as? String, unsent)
    app.terminate()
    app.launch()
    XCTAssertTrue(message.waitForExistence(timeout: 10))
    XCTAssertEqual(message.label, receipt.text)
    XCTAssertEqual(app.textFields["message-draft"].value as? String, unsent)
    XCTAssertEqual(app.staticTexts["voice-status"].label, "Voice is off")
  }

}

@MainActor private func launchVoiceFixture(test: XCTestCase) async throws -> XCUIApplication {
  let session = URLSession(configuration: .ephemeral)
  defer { session.invalidateAndCancel() }
  let controlURL = try voiceFixtureControlURL()
  var components = URLComponents(
    url: controlURL.appendingPathComponent("conversation/messages"), resolvingAgainstBaseURL: false)!
  components.queryItems = [URLQueryItem(name: "limit", value: "1")]
  var probe = URLRequest(url: components.url!)
  probe.timeoutInterval = 10
  do {
    let (_, response) = try await session.data(for: probe)
    guard (response as? HTTPURLResponse)?.statusCode == 200 else {
      throw URLError(.cannotConnectToHost)
    }
  } catch {
    if ProcessInfo.processInfo.environment["BALABOL_VOICE_UI_CONTROL_URL"] != nil { throw error }
    throw XCTSkip("Start the isolated LiveKit voice fixture on port 8788.")
  }
  let app = XCUIApplication()
  app.launchEnvironment["BALABOL_UI_TEST_NAMESPACE"] = UUID().uuidString
  app.launchEnvironment["BALABOL_UI_TEST_CONTROL_URL"] = controlURL.absoluteString
  app.launch()
  XCTAssertTrue(app.buttons["start-voice"].waitForExistence(timeout: 5))
  XCTAssertTrue(app.staticTexts["scripted-transcription"].exists)
  return app
}

/// Physical iOS may present the permission sheet in SpringBoard rather than
/// the app process. Recognize this app's microphone sheet before approving it.
@MainActor private func handleMicrophonePermission(_ app: XCUIApplication, test: XCTestCase) async
  -> Bool
{
  let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
  let microphoneWords = [
    "microphone", "mikrofon", "micrófono", "microfone", "микроф", "麦克风", "麥克風", "マイク", "마이크",
  ]
  let positiveLabels = [
    "Allow", "OK", "Разрешить", "Autoriser", "Zulassen", "Permitir", "允许", "允許", "許可", "허용",
  ]
  for _ in 0..<40 {
    let systemAlert = springboard.alerts.firstMatch
    let alert = systemAlert.exists ? systemAlert : app.alerts.firstMatch
    if alert.exists {
      let description = ([alert.label] + alert.staticTexts.allElementsBoundByIndex.map(\.label))
        .joined(separator: " ").lowercased()
      guard description.contains("balabol"), microphoneWords.contains(where: description.contains)
      else {
        attachMicrophoneFailure(alert, springboard: springboard, test: test)
        XCTFail("An unrelated or unrecognized alert blocked microphone permission")
        return false
      }
      if let button = positiveLabels.map({ alert.buttons[$0] }).first(where: { $0.exists }) {
        button.tap()
        return true
      }
      attachMicrophoneFailure(alert, springboard: springboard, test: test)
      XCTFail("Recognized Balabol microphone prompt has no recognized approval button")
      return false
    }
    let status = app.staticTexts["voice-status"]
    if status.exists, status.label != "Requesting microphone…" { return true }
    try? await Task.sleep(for: .milliseconds(250))
  }
  let alert = springboard.alerts.firstMatch
  attachMicrophoneFailure(alert, springboard: springboard, test: test)
  XCTFail("Microphone permission did not resolve within its bounded wait")
  return false
}

@MainActor private func attachMicrophoneFailure(
  _ alert: XCUIElement, springboard: XCUIApplication, test: XCTestCase
) {
  let description = XCTAttachment(
    string: alert.exists ? alert.debugDescription : "No SpringBoard alert found")
  description.name = "Microphone permission accessibility"
  description.lifetime = .keepAlways
  test.add(description)
  let screenshot = XCTAttachment(screenshot: springboard.screenshot())
  screenshot.name = "Microphone permission failure"
  screenshot.lifetime = .keepAlways
  test.add(screenshot)
}

@MainActor private func revealInterruptedReceipt(
  _ app: XCUIApplication, position: Int, test: XCTestCase
) async -> Bool {
  let marker = app.staticTexts["interrupted-message-\(position)"]
  let text = app.staticTexts["assistant-message-\(position)"]
  let transcript = app.collectionViews.firstMatch
  guard transcript.exists else { return false }
  // SwiftUI List creates only visible rows. The latest response and focused
  // keyboard can hide this earlier receipt; scroll within the transcript only.
  for _ in 0..<20 {
    if marker.exists, text.exists, marker.isHittable, text.isHittable { return true }
    let visiblePositions = app.staticTexts.allElementsBoundByIndex.compactMap { element -> Int? in
      guard element.identifier.hasPrefix("assistant-message-"), element.isHittable else {
        return nil
      }
      return Int(element.identifier.dropFirst("assistant-message-".count))
    }
    if let latest = visiblePositions.max(), latest < position {
      let start = transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
      let end = transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
      start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.2)
    } else {
      let start = transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
      let end = transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
      start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.2)
    }
    try? await Task.sleep(for: .milliseconds(200))
  }
  let attachment = XCTAttachment(screenshot: app.screenshot())
  attachment.name = "Interrupted receipt visibility failure"
  attachment.lifetime = .keepAlways
  test.add(attachment)
  return false
}

private struct VoiceFixtureCurrent: Decodable {
  struct Reply: Decodable { let responseId: UUID }
  let reply: Reply?
  struct Receipt: Decodable {
    let deliveryId: UUID
    let text: String
    let position: Int
    let languageSpans: [VoiceFixtureLanguageSpan]?
  }
  let input: Receipt
}

private struct VoiceFixtureReply: Decodable {
  struct Receipt: Decodable {
    let deliveryId: UUID
    let responseId: UUID
    let inputDeliveryId: UUID
    let position: Int
    let text: String
    let role: String
    let outcome: String
    let languageSpans: [VoiceFixtureLanguageSpan]?
  }
  let responseId: UUID
  let state: String
  let languageSpans: [VoiceFixtureLanguageSpan]?
  let receipt: Receipt?
}

private func currentVoiceFixtureTurn() async throws -> VoiceFixtureCurrent {
  let configuration = URLSessionConfiguration.ephemeral
  configuration.timeoutIntervalForRequest = 3
  configuration.timeoutIntervalForResource = 3
  let session = URLSession(configuration: configuration)
  defer { session.invalidateAndCancel() }
  let (data, response) = try await session.data(
    from: try voiceFixtureControlURL().appendingPathComponent("conversation/current"))
  guard (response as? HTTPURLResponse)?.statusCode == 200 else {
    throw URLError(.badServerResponse)
  }
  return try JSONDecoder().decode(VoiceFixtureCurrent.self, from: data)
}

private func terminalVoiceFixtureReply(input: UUID) async throws -> VoiceFixtureReply {
  let configuration = URLSessionConfiguration.ephemeral
  configuration.timeoutIntervalForRequest = 3
  configuration.timeoutIntervalForResource = 3
  let session = URLSession(configuration: configuration)
  defer { session.invalidateAndCancel() }
  let url = try voiceFixtureControlURL().appendingPathComponent(
    "conversation/replies/" + input.uuidString)
  let deadline = ContinuousClock.now.advanced(by: .seconds(10))
  while ContinuousClock.now < deadline {
    let (data, response) = try await session.data(from: url)
    guard (response as? HTTPURLResponse)?.statusCode == 200 else {
      throw URLError(.badServerResponse)
    }
    let reply = try JSONDecoder().decode(VoiceFixtureReply.self, from: data)
    if ["Interrupted", "Completed", "Failed"].contains(reply.state) { return reply }
    try await Task.sleep(for: .milliseconds(250))
  }
  throw URLError(.timedOut)
}

private func voiceFixtureControlURL() throws -> URL {
  let configured = ProcessInfo.processInfo.environment["BALABOL_VOICE_UI_CONTROL_URL"]
  #if targetEnvironment(simulator)
    let value = configured ?? "http://127.0.0.1:8788"
  #else
    guard let value = configured else { throw URLError(.badURL) }
  #endif
  guard let url = URL(string: value), ["http", "https"].contains(url.scheme), url.host != nil,
    url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
    ["", "/"].contains(url.path)
  else { throw URLError(.badURL) }
  return url
}

private struct VoiceFixtureHistory: Decodable {
  struct Message: Decodable {
    let deliveryId: UUID
    let role: String
    let position: Int
  }
  let messages: [Message]
  let nextAfter: Int?
}

private func voiceFixtureHistory(after: Int) async throws -> VoiceFixtureHistory {
  let base = try voiceFixtureControlURL().appendingPathComponent("conversation/messages")
  guard var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else {
    throw URLError(.badURL)
  }
  components.queryItems = [
    URLQueryItem(name: "after", value: String(after)), URLQueryItem(name: "limit", value: "100"),
  ]
  guard let url = components.url else { throw URLError(.badURL) }
  let configuration = URLSessionConfiguration.ephemeral
  configuration.timeoutIntervalForRequest = 3
  configuration.timeoutIntervalForResource = 3
  let session = URLSession(configuration: configuration)
  defer { session.invalidateAndCancel() }
  let (data, response) = try await session.data(from: url)
  guard (response as? HTTPURLResponse)?.statusCode == 200 else {
    throw URLError(.badServerResponse)
  }
  return try JSONDecoder().decode(VoiceFixtureHistory.self, from: data)
}

private struct VoiceFixtureLanguageSpan: Decodable, Equatable {
  let language: String
  let start: Int
  let end: Int
}

private func currentVoiceFixtureTurnIfAny() async throws -> VoiceFixtureCurrent? {
  let configuration = URLSessionConfiguration.ephemeral
  configuration.timeoutIntervalForRequest = 3
  configuration.timeoutIntervalForResource = 3
  let session = URLSession(configuration: configuration)
  defer { session.invalidateAndCancel() }
  let (data, response) = try await session.data(
    from: try voiceFixtureControlURL().appendingPathComponent("conversation/current"))
  guard (response as? HTTPURLResponse)?.statusCode == 200 else {
    throw URLError(.badServerResponse)
  }
  return try JSONDecoder().decode(VoiceFixtureCurrent?.self, from: data)
}

private func nextVoiceFixtureTurn(after previous: UUID?) async throws -> VoiceFixtureCurrent {
  let deadline = ContinuousClock.now.advanced(by: .seconds(20))
  while ContinuousClock.now < deadline {
    if let current = try await currentVoiceFixtureTurnIfAny(), current.input.deliveryId != previous
    {
      return current
    }
    try await Task.sleep(for: .milliseconds(200))
  }
  throw URLError(.timedOut)
}

private func fixtureLanguageNames(_ languages: [String]) -> String {
  var seen: Set<String> = []
  return languages.compactMap { tag in
    guard seen.insert(tag).inserted else { return nil }
    return Locale.current.localizedString(forIdentifier: tag) ?? tag
  }.joined(separator: " · ")
}

@MainActor private func revealLanguageReceipt(
  _ app: XCUIApplication, position: Int, assistant: Bool
) async -> Bool {
  let body = app.staticTexts[(assistant ? "assistant-message-" : "message-") + String(position)]
  let caption = app.staticTexts["message-languages-\(position)"]
  let transcript = app.collectionViews.firstMatch
  guard transcript.exists else { return false }
  for _ in 0..<24 {
    if body.exists, caption.exists, body.isHittable, caption.isHittable { return true }
    let visible = app.staticTexts.allElementsBoundByIndex.compactMap { element -> Int? in
      let identifier = element.identifier
      for prefix in ["assistant-message-", "message-"] where identifier.hasPrefix(prefix) {
        guard let value = Int(identifier.dropFirst(prefix.count)) else { continue }
        return element.isHittable ? value : nil
      }
      return nil
    }
    let towardLater = visible.max().map { $0 < position } ?? false
    let start = transcript.coordinate(
      withNormalizedOffset: CGVector(dx: 0.5, dy: towardLater ? 0.7 : 0.3))
    let end = transcript.coordinate(
      withNormalizedOffset: CGVector(dx: 0.5, dy: towardLater ? 0.3 : 0.7))
    start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.2)
    try? await Task.sleep(for: .milliseconds(200))
  }
  return false
}

private func voiceFixtureReply(input: UUID) async throws -> VoiceFixtureReply {
  let configuration = URLSessionConfiguration.ephemeral
  configuration.timeoutIntervalForRequest = 3
  configuration.timeoutIntervalForResource = 3
  let session = URLSession(configuration: configuration)
  defer { session.invalidateAndCancel() }
  let (data, response) = try await session.data(
    from: try voiceFixtureControlURL().appendingPathComponent(
      "conversation/replies/" + input.uuidString))
  guard (response as? HTTPURLResponse)?.statusCode == 200 else {
    throw URLError(.badServerResponse)
  }
  return try JSONDecoder().decode(VoiceFixtureReply.self, from: data)
}

@MainActor private func uninterruptedVoiceFixtureReply(
  input: UUID, playing: XCUIElement,
  ordinal: Int, logger: os.Logger
) async throws -> VoiceFixtureReply? {
  let deadline = ContinuousClock.now.advanced(by: .seconds(20))
  var sawPlaying = false
  while ContinuousClock.now < deadline {
    let first = try await voiceFixtureReply(input: input)
    let current = try await currentVoiceFixtureTurn()
    // The exact reply endpoint remains tied to this input. Current is only an
    // extra-input detector, never authority to replace the response identity.
    if current.input.deliveryId != input {
      logger.notice(
        "multilingual extra input ordinal=\(ordinal, privacy: .public) input=\(current.input.deliveryId.uuidString, privacy: .public) prior=\(input.uuidString, privacy: .public) replyState=\(first.state, privacy: .public)"
      )
      XCTFail("Unexpected accepted input during this wave's exact fixture reply")
      return nil
    }
    if ["Interrupted", "Failed"].contains(first.state) {
      logger.notice(
        "multilingual premature terminal ordinal=\(ordinal, privacy: .public) input=\(input.uuidString, privacy: .public) response=\(first.responseId.uuidString, privacy: .public) replyState=\(first.state, privacy: .public)"
      )
      XCTFail("Exact controlled-wave reply was interrupted or failed")
      return nil
    }
    sawPlaying = sawPlaying || playing.exists
    if first.state == "Completed" {
      guard sawPlaying else {
        XCTFail("Actual subscribed SDK fixture PCM was not observed")
        return nil
      }
      return first
    }
    try await Task.sleep(for: .milliseconds(200))
  }
  XCTFail("Exact controlled-wave SDK fixture reply did not complete within its bounded wait")
  return nil
}
