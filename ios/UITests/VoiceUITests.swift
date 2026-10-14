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
    app.buttons["end-voice"].tap()
    let ended = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "label == %@", "Voice ended"), object: status)
    let endResult = await XCTWaiter.fulfillment(of: [ended], timeout: 10)
    XCTAssertEqual(endResult, .completed)
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
    let interrupted = try await interruptedVoiceFixtureReply(input: prior.input.deliveryId)
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
    let interrupted = try await interruptedVoiceFixtureReply(input: prior.input.deliveryId)
    XCTAssertEqual(interrupted.responseId, response)
    guard interrupted.state == "Interrupted" else {
      XCTFail("Acoustic onset did not interrupt the exact Playing response")
      return
    }
    let beforeFinal = try await currentVoiceFixtureTurn()
    XCTAssertEqual(beforeFinal.input.deliveryId, prior.input.deliveryId)
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
    let interrupted = try await interruptedVoiceFixtureReply(input: prior.input.deliveryId)
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
  }
  let responseId: UUID
  let state: String
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

private func interruptedVoiceFixtureReply(input: UUID) async throws -> VoiceFixtureReply {
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
