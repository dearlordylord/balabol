import Foundation
import XCTest

@MainActor
final class VoiceCaptureUITests: XCTestCase {
  func testRealSimulatorMicrophonePublishesMuteAndEnd() async throws {
    let app = try await launchVoiceFixture(test: self)
    defer { app.terminate() }
    app.buttons["start-voice"].tap()
    app.tap()
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
  func testActualMicrophoneUtteranceIsSavedWithoutChangingDraftAndSurvivesRelaunch() async throws {
    let app = try await launchVoiceFixture(test: self)
    defer { app.terminate() }
    let draft = app.textFields["message-draft"]
    let unsent = "Independent text draft " + UUID().uuidString
    draft.tap()
    draft.typeText(unsent)
    app.buttons["start-voice"].tap()
    app.tap()
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
  test.addUIInterruptionMonitor(withDescription: "Microphone permission") { alert in
    if alert.buttons["Allow"].exists {
      alert.buttons["Allow"].tap()
      return true
    }
    if alert.buttons["OK"].exists {
      alert.buttons["OK"].tap()
      return true
    }
    return false
  }
  app.launch()
  XCTAssertTrue(app.buttons["start-voice"].waitForExistence(timeout: 5))
  XCTAssertTrue(app.staticTexts["scripted-transcription"].exists)
  return app
}

private struct VoiceFixtureCurrent: Decodable {
  struct Receipt: Decodable {
    let deliveryId: UUID
    let text: String
    let position: Int
  }
  let input: Receipt
}

private func voiceFixtureControlURL() throws -> URL {
  let value =
    ProcessInfo.processInfo.environment["BALABOL_VOICE_UI_CONTROL_URL"] ?? "http://127.0.0.1:8788"
  guard let url = URL(string: value), ["http", "https"].contains(url.scheme), url.host != nil,
    url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
    ["", "/"].contains(url.path)
  else { throw URLError(.badURL) }
  return url
}
