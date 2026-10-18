import Foundation
import XCTest

@MainActor
final class TextDeliveryUITests: XCTestCase {
  func testLiveReplyDoesNotLeaveTranscriptBlankWithVariableHeightHistory() async throws {
    let server = "http://127.0.0.1:8792"
    do { _ = try await URLSession.shared.data(from: URL(string: server + "/test/reset")!) } catch {
      throw XCTSkip("Run conversation-live-ui-fixture.mjs for this isolated UI check.")
    }
    let app = XCUIApplication()
    defer { app.terminate() }
    app.launchEnvironment["BALABOL_UI_TEST_NAMESPACE"] = UUID().uuidString
    app.launchEnvironment["BALABOL_UI_TEST_CONTROL_URL"] = server
    app.launch()
    XCTAssertTrue(app.staticTexts["message-94"].waitForExistence(timeout: 10))
    _ = try await URLSession.shared.data(from: URL(string: server + "/test/start")!)
    app.buttons["Refresh conversation"].tap()
    let projection = app.staticTexts["reply-progress"]
    XCTAssertTrue(projection.waitForExistence(timeout: 5))
    app.buttons["start-voice"].tap()
    for step in 0..<12 {
      if step % 4 == 1 {
        app.descendants(matching: .any)["message-draft"].firstMatch.tap()
        app.buttons["Done"].tap()
      }
      _ = try await URLSession.shared.data(from: URL(string: server + "/test/step")!)
      let visible =
        projection.exists
        && projection.frame.intersects(app.scrollViews["conversation-transcript"].frame)
      let completed = app.staticTexts["assistant-message-96"]
      XCTAssertTrue(
        visible || (completed.exists && completed.isHittable),
        "A streaming or saved reply must remain visible; the transcript must not become blank.")
      if projection.exists {
        XCTAssertLessThanOrEqual(projection.frame.maxY,
          app.scrollViews["conversation-transcript"].frame.maxY + 2,
          "Following must reveal the end of a growing reply after layout changes.")
      }
      try await Task.sleep(for: .milliseconds(200))
    }
    _ = try await URLSession.shared.data(from: URL(string: server + "/test/finish")!)
    XCTAssertTrue(app.staticTexts["assistant-message-96"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["assistant-message-96"].isHittable)
  }

  func testReturningToBottomResumesFollowingNewReplies() async throws {
    let server = "http://127.0.0.1:8792"
    do { _ = try await URLSession.shared.data(from: URL(string: server + "/test/reset")!) } catch {
      throw XCTSkip("Run conversation-live-ui-fixture.mjs for this isolated UI check.")
    }
    let app = XCUIApplication()
    defer { app.terminate() }
    app.launchEnvironment["BALABOL_UI_TEST_NAMESPACE"] = UUID().uuidString
    app.launchEnvironment["BALABOL_UI_TEST_CONTROL_URL"] = server
    app.launch()
    XCTAssertTrue(app.staticTexts["message-94"].waitForExistence(timeout: 10))
    let transcript = app.scrollViews["conversation-transcript"]
    transcript.swipeDown()
    XCTAssertTrue(app.buttons["latest-message"].waitForExistence(timeout: 3))
    for _ in 0..<8 {
      if app.staticTexts["About this prototype"].isHittable { break }
      transcript.swipeUp()
    }
    XCTAssertTrue(app.staticTexts["About this prototype"].isHittable)
    XCTAssertFalse(app.buttons["latest-message"].exists,
      "Returning to the bottom must resume following without a separate button tap.")
    _ = try await URLSession.shared.data(from: URL(string: server + "/test/start")!)
    app.buttons["Refresh conversation"].tap()
    XCTAssertTrue(app.staticTexts["reply-progress"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["reply-progress"].isHittable,
      "A new reply must appear in the viewport after returning to the bottom.")
    _ = try await URLSession.shared.data(from: URL(string: server + "/test/finish")!)
    XCTAssertTrue(app.staticTexts["assistant-message-96"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["assistant-message-96"].isHittable)
  }

  func testLatestHistoryAndOlderPrependPreserveReadingPosition() async throws {
    let server = "http://127.0.0.1:8791"
    var probe = URLRequest(url: URL(string: server + "/conversation/messages?direction=older")!)
    probe.timeoutInterval = 2
    do { _ = try await URLSession.shared.data(for: probe) } catch {
      throw XCTSkip("Run node scripts/quality/history-ui-fixture.mjs for this isolated UI check.")
    }
    let app = XCUIApplication()
    defer { app.terminate() }
    app.launchEnvironment["BALABOL_UI_TEST_NAMESPACE"] = UUID().uuidString
    app.launchEnvironment["BALABOL_UI_TEST_CONTROL_URL"] = server
    app.launch()
    let latest = app.staticTexts["message-204"]
    XCTAssertTrue(latest.waitForExistence(timeout: 10))
    XCTAssertTrue(latest.isHittable, "Opening the conversation must reveal its latest message.")
    XCTAssertFalse(app.staticTexts["message-0"].exists)
    let transcript = app.scrollViews["conversation-transcript"]
    let older = app.buttons["load-older-messages"]
    // Native status-bar tap reaches the oldest loaded row; swipes cover SDKs without it.
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.02)).tap()
    for _ in 0..<35 {
      if older.exists && older.isHittable { break }
      transcript.swipeDown(velocity: .fast)
    }
    XCTAssertTrue(older.isHittable)
    let boundary = app.staticTexts["message-105"]
    XCTAssertTrue(boundary.isHittable)
    let originalY = boundary.frame.minY
    older.tap()
    let previous = app.staticTexts["message-104"]
    if !previous.waitForExistence(timeout: 5) {
      XCTFail("Prepend did not restore the boundary row")
      return
    }
    XCTAssertTrue(boundary.isHittable)
    XCTAssertEqual(
      boundary.frame.minY, originalY, accuracy: 4,
      "Prepending older history must retain the visible message's position.")
    if app.buttons["latest-message"].exists { app.buttons["latest-message"].tap() }
    XCTAssertTrue(latest.isHittable)
    app.terminate()
    app.launch()
    XCTAssertTrue(latest.waitForExistence(timeout: 10))
    XCTAssertTrue(latest.isHittable)
  }

  func testNamespacedDebugLaunchUsesPreconfiguredControlURLWithoutTyping() {
    let app = XCUIApplication()
    defer { app.terminate() }
    app.launchEnvironment["BALABOL_UI_TEST_NAMESPACE"] = UUID().uuidString
    app.launchEnvironment["BALABOL_UI_TEST_CONTROL_URL"] = "http://127.0.0.1:1"
    app.launch()
    XCTAssertTrue(
      app.descendants(matching: .any)["message-draft"].firstMatch.waitForExistence(timeout: 5))
    XCTAssertFalse(app.textFields["server-url"].exists)
    app.buttons["Server"].tap()
    let address = app.textFields["server-url"]
    XCTAssertTrue(address.waitForExistence(timeout: 5))
    XCTAssertEqual(address.value as? String, "http://127.0.0.1:1")
  }

  func testNamespacedDebugLaunchRejectsCredentialBearingControlURL() {
    let app = XCUIApplication()
    defer { app.terminate() }
    app.launchEnvironment["BALABOL_UI_TEST_NAMESPACE"] = UUID().uuidString
    app.launchEnvironment["BALABOL_UI_TEST_CONTROL_URL"] = "https://example:fixture@example.invalid"
    app.launch()
    XCTAssertTrue(app.textFields["server-url"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["start-voice"].exists)
    XCTAssertTrue(
      app.staticTexts["Enter a valid HTTP or HTTPS server URL without credentials or a path."]
        .exists)
  }

  func testFreshSimulatorOpensConversationWithoutServerSetup() throws {
    #if !targetEnvironment(simulator)
      throw XCTSkip("Automatic localhost setup is only available on Simulator.")
    #endif
    let app = XCUIApplication()
    defer { app.terminate() }
    app.launchEnvironment["BALABOL_UI_TEST_NAMESPACE"] = UUID().uuidString
    app.launch()
    XCTAssertTrue(
      app.descendants(matching: .any)["message-draft"].firstMatch.waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["send-message"].exists)
    XCTAssertFalse(app.textFields["server-url"].exists)
    XCTAssertFalse(app.buttons["Connect"].exists)
  }

  func testServerSheetCanBeCancelledWithoutLosingDraftOrConnection() {
    let app = XCUIApplication()
    defer { app.terminate() }
    app.launchEnvironment["BALABOL_UI_TEST_NAMESPACE"] = UUID().uuidString
    app.launchEnvironment["BALABOL_UI_TEST_CONTROL_URL"] = "http://127.0.0.1:1"
    app.launch()
    let draft = app.descendants(matching: .any)["message-draft"].firstMatch
    XCTAssertTrue(draft.waitForExistence(timeout: 5))
    draft.tap()
    draft.typeText("Keep my unsent message")
    app.buttons["Server"].tap()
    let address = app.textFields["server-url"]
    XCTAssertTrue(address.waitForExistence(timeout: 5))
    address.tap()
    address.press(forDuration: 1)
    if app.menuItems["Select All"].waitForExistence(timeout: 1) {
      app.menuItems["Select All"].tap()
      address.typeText("https://fixture:secret@example.invalid")
    } else if let current = address.value as? String {
      address.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count))
      address.typeText("https://fixture:secret@example.invalid")
    }
    app.buttons["Connect"].tap()
    XCTAssertTrue(app.staticTexts["server-error"].waitForExistence(timeout: 3))
    app.buttons["Cancel"].tap()
    XCTAssertTrue(draft.waitForExistence(timeout: 3))
    XCTAssertEqual(draft.value as? String, "Keep my unsent message")
    XCTAssertTrue(draft.isEnabled)
    app.buttons["Server"].tap()
    XCTAssertEqual(address.value as? String, "http://127.0.0.1:1")
    app.buttons["Cancel"].tap()
  }

  func testAccessibilityTextKeepsVoiceAndComposerReachable() {
    let app = XCUIApplication()
    defer { app.terminate() }
    app.launchEnvironment["BALABOL_UI_TEST_NAMESPACE"] = UUID().uuidString
    app.launchEnvironment["BALABOL_UI_TEST_CONTROL_URL"] = "http://127.0.0.1:1"
    app.launchArguments += [
      "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL",
    ]
    app.launch()
    let draft = app.descendants(matching: .any)["message-draft"].firstMatch
    XCTAssertTrue(draft.waitForExistence(timeout: 5))
    let start = app.buttons["start-voice"]
    let transcript = app.scrollViews["conversation-transcript"]
    for _ in 0..<8 where !start.isHittable { transcript.swipeDown() }
    XCTAssertTrue(start.isHittable)
    XCTAssertGreaterThanOrEqual(start.frame.height, 44)
    XCTAssertGreaterThanOrEqual(app.buttons["send-message"].frame.height, 44)
    draft.tap()
    draft.typeText("A multiline draft\nwith a second line\nand a third line")
    XCTAssertTrue(draft.isHittable)
    XCTAssertTrue(app.buttons["send-message"].isHittable)
    if app.keyboards.firstMatch.exists {
      XCTAssertGreaterThan(draft.frame.minY - app.navigationBars.firstMatch.frame.maxY, 150)
    }
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = "Accessibility text and keyboard"
    screenshot.lifetime = .keepAlways
    add(screenshot)
  }

  func testNativeControlsHaveAccessibleLabelsAndAdaptToLandscape() throws {
    let app = XCUIApplication()
    defer {
      XCUIDevice.shared.orientation = .portrait
      app.terminate()
    }
    app.launchEnvironment["BALABOL_UI_TEST_NAMESPACE"] = UUID().uuidString
    app.launchEnvironment["BALABOL_UI_TEST_CONTROL_URL"] = "http://127.0.0.1:8788"
    app.launch()
    let draft = app.descendants(matching: .any)["message-draft"].firstMatch
    XCTAssertTrue(draft.waitForExistence(timeout: 5))
    try app.performAccessibilityAudit(for: [.hitRegion, .sufficientElementDescription])
    let portrait = XCTAttachment(screenshot: app.screenshot())
    portrait.name = "Native conversation portrait"
    portrait.lifetime = .keepAlways
    add(portrait)
    XCUIDevice.shared.orientation = .landscapeLeft
    var previousFrame: CGRect?
    var stableSamples = 0
    let landscapeReady = XCTNSPredicateExpectation(
      predicate: NSPredicate { _, _ in
        let frame = app.windows.firstMatch.frame
        stableSamples = frame == previousFrame ? stableSamples + 1 : 0
        previousFrame = frame
        return frame.width > frame.height && stableSamples >= 3
      },
      object: nil)
    XCTAssertEqual(XCTWaiter.wait(for: [landscapeReady], timeout: 8), .completed)
    XCTAssertTrue(draft.isHittable)
    XCTAssertTrue(app.buttons["send-message"].isHittable)
    let landscapeImage = app.screenshot()
    // Simulator framebuffer dimensions can lag the settled window rotation.
    let window = app.windows.firstMatch.frame
    XCTAssertLessThanOrEqual(draft.frame.maxX, window.maxX + 1)
    XCTAssertLessThanOrEqual(draft.frame.maxY, window.maxY + 1)
    XCTAssertLessThanOrEqual(app.buttons["send-message"].frame.maxY, window.maxY + 1)
    let landscape = XCTAttachment(screenshot: landscapeImage)
    landscape.name = "Compact height conversation"
    landscape.lifetime = .keepAlways
    add(landscape)
  }

  func testUnreachableServerRetainsDraftAcrossRelaunch() {
    let app = XCUIApplication()
    defer { app.terminate() }
    app.launchEnvironment["BALABOL_UI_TEST_NAMESPACE"] = UUID().uuidString
    app.launch()
    let server = app.buttons["Server"]
    XCTAssertTrue(server.waitForExistence(timeout: 5))
    let ready = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "enabled == true"), object: server)
    XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 5), .completed)
    server.tap()
    let address = app.textFields["server-url"]
    XCTAssertTrue(address.waitForExistence(timeout: 5))
    address.tap()
    if let current = address.value as? String {
      address.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count))
    }
    address.typeText("http://127.0.0.1:1")
    app.buttons["Connect"].tap()
    let draft = app.descendants(matching: .any)["message-draft"].firstMatch
    XCTAssertTrue(draft.waitForExistence(timeout: 5))
    draft.tap()
    draft.typeText("Retain this draft")
    app.buttons["send-message"].tap()
    XCTAssertTrue(app.staticTexts["delivery-status"].waitForExistence(timeout: 35))
    XCTAssertEqual(draft.value as? String, "Retain this draft")
    XCTAssertFalse(draft.isEnabled)
    app.terminate()
    app.launch()
    XCTAssertTrue(app.buttons["Retry same message"].waitForExistence(timeout: 5))
    XCTAssertEqual(
      app.descendants(matching: .any)["message-draft"].firstMatch.value as? String,
      "Retain this draft")
  }
  func testRealReplyStreamsThenSurvivesRelaunch() async throws {
    let session = URLSession(configuration: .ephemeral)
    defer { session.invalidateAndCancel() }
    var probe = URLRequest(url: URL(string: "http://127.0.0.1:8788/conversation/messages?limit=1")!)
    probe.timeoutInterval = 2
    do {
      let (_, response) = try await session.data(for: probe)
      guard (response as? HTTPURLResponse)?.statusCode == 200 else {
        throw XCTSkip(
          "Start the isolated fake-provider fixture on port 8788 for reply UI acceptance.")
      }
    } catch {
      throw XCTSkip(
        "Start the isolated fake-provider fixture on port 8788 for reply UI acceptance.")
    }
    let app = XCUIApplication()
    defer { app.terminate() }
    app.launchEnvironment["BALABOL_UI_TEST_NAMESPACE"] = UUID().uuidString
    app.launch()
    let server = app.buttons["Server"]
    XCTAssertTrue(server.waitForExistence(timeout: 5))
    let ready = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "enabled == true"), object: server)
    let readiness = await XCTWaiter.fulfillment(of: [ready], timeout: 5)
    XCTAssertEqual(readiness, .completed)
    server.tap()
    let address = app.textFields["server-url"]
    XCTAssertTrue(address.waitForExistence(timeout: 5))
    address.tap()
    if let current = address.value as? String {
      address.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count))
    }
    address.typeText("http://127.0.0.1:8788")
    app.buttons["Connect"].tap()
    let draft = app.descendants(matching: .any)["message-draft"].firstMatch
    XCTAssertTrue(draft.waitForExistence(timeout: 5))
    let input = "UI reply " + UUID().uuidString
    draft.tap()
    draft.typeText(input)
    app.buttons["send-message"].tap()
    XCTAssertTrue(app.buttons["About this prototype"].exists)
    let progress = app.staticTexts["reply-progress"]
    XCTAssertTrue(progress.waitForExistence(timeout: 15))
    XCTAssertFalse(progress.label.isEmpty)
    let answer = app.staticTexts.matching(
      NSPredicate(
        format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "assistant-message-", input)
    ).firstMatch
    XCTAssertTrue(answer.waitForExistence(timeout: 20))
    let completedText = answer.label
    XCTAssertFalse(progress.exists)
    app.terminate()
    app.launch()
    XCTAssertTrue(answer.waitForExistence(timeout: 10))
    XCTAssertEqual(answer.label, completedText)
  }

  func testNewTextInterruptsStreamingReplyAndSurvivesRelaunch() async throws {
    let session = URLSession(configuration: .ephemeral)
    defer { session.invalidateAndCancel() }
    var probe = URLRequest(url: URL(string: "http://127.0.0.1:8788/conversation/messages?limit=1")!)
    probe.timeoutInterval = 2
    guard let (_, response) = try? await session.data(for: probe),
      (response as? HTTPURLResponse)?.statusCode == 200
    else { throw XCTSkip("Start the isolated fake-provider fixture on port 8788.") }
    let app = XCUIApplication()
    defer { app.terminate() }
    app.launchEnvironment["BALABOL_UI_TEST_NAMESPACE"] = UUID().uuidString
    app.launch()
    let server = app.buttons["Server"]
    XCTAssertTrue(server.waitForExistence(timeout: 5))
    let ready = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "enabled == true"), object: server)
    let readiness = await XCTWaiter.fulfillment(of: [ready], timeout: 5)
    XCTAssertEqual(readiness, .completed)
    server.tap()
    let address = app.textFields["server-url"]
    XCTAssertTrue(address.waitForExistence(timeout: 5))
    address.tap()
    if let current = address.value as? String {
      address.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count))
    }
    address.typeText("http://127.0.0.1:8788")
    app.buttons["Connect"].tap()
    let draft = app.descendants(matching: .any)["message-draft"].firstMatch
    XCTAssertTrue(draft.waitForExistence(timeout: 5))
    let first = "First UI " + UUID().uuidString.prefix(8) + " " + String(repeating: "x", count: 136)
    let second = "Fix UI " + UUID().uuidString.prefix(8)
    draft.tap()
    draft.typeText(first)
    app.buttons["send-message"].tap()
    let progress = app.staticTexts["reply-progress"]
    XCTAssertTrue(progress.waitForExistence(timeout: 15))
    let partial = progress.label
    let (currentData, _) = try await session.data(
      from: URL(string: "http://127.0.0.1:8788/conversation/current")!)
    let current = try JSONDecoder().decode(MemoryFixtureTurn.self, from: currentData)
    XCTAssertEqual(current.input.text, first)
    let firstPosition = current.input.position
    draft.tap()
    draft.typeText(second)
    XCTAssertTrue(app.buttons["send-message"].isEnabled)
    app.buttons["send-message"].tap()
    if app.buttons["Done"].exists { app.buttons["Done"].tap() }
    let interrupted = app.staticTexts["interrupted-message-\(firstPosition + 1)"]
    let interruptedVisible = await revealInterruptedReceipt(
      app, position: firstPosition + 1, test: self)
    XCTAssertTrue(interruptedVisible)
    let retained = app.staticTexts["assistant-message-\(firstPosition + 1)"]
    XCTAssertTrue(retained.exists)
    XCTAssertTrue(retained.label.hasPrefix(partial))
    if app.buttons["latest-message"].exists { app.buttons["latest-message"].tap() }
    let answer = app.staticTexts.matching(
      NSPredicate(
        format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "assistant-message-", second)
    ).firstMatch
    XCTAssertTrue(answer.waitForExistence(timeout: 25))
    let answerText = answer.label
    app.terminate()
    app.launch()
    // The newest history page contains both recent turns without forward pagination.
    XCTAssertTrue(answer.waitForExistence(timeout: 10))
    XCTAssertEqual(answer.label, answerText)
    let restoredInterrupted = await revealInterruptedReceipt(
      app, position: firstPosition + 1, test: self)
    XCTAssertTrue(restoredInterrupted)
    XCTAssertTrue(interrupted.exists)
    XCTAssertTrue(retained.exists)
  }

  func testFailedMemoryReplyRetriesWithoutReplacingDraftAndRestoresOnRelaunch() async throws {
    let session = URLSession(configuration: .ephemeral)
    defer { session.invalidateAndCancel() }
    var probe = URLRequest(url: URL(string: "http://127.0.0.1:8788/conversation/current")!)
    probe.timeoutInterval = 2
    guard let (data, response) = try? await session.data(for: probe),
      (response as? HTTPURLResponse)?.statusCode == 200,
      let turn = try? JSONDecoder().decode(MemoryFixtureTurn.self, from: data),
      turn.reply.state == "Failed"
    else { throw XCTSkip("Preseed the isolated failed-summary fixture on port 8788.") }
    let app = XCUIApplication()
    defer { app.terminate() }
    app.launchEnvironment["BALABOL_UI_TEST_NAMESPACE"] = UUID().uuidString
    app.launch()
    let server = app.buttons["Server"]
    XCTAssertTrue(server.waitForExistence(timeout: 5))
    let ready = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "enabled == true"), object: server)
    let readiness = await XCTWaiter.fulfillment(of: [ready], timeout: 5)
    XCTAssertEqual(readiness, .completed)
    server.tap()
    let address = app.textFields["server-url"]
    XCTAssertTrue(address.waitForExistence(timeout: 5))
    address.tap()
    if let current = address.value as? String {
      address.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count))
    }
    address.typeText("http://127.0.0.1:8788")
    app.buttons["Connect"].tap()
    let failure = app.staticTexts["reply-provider-status"]
    XCTAssertTrue(failure.waitForExistence(timeout: 10))
    XCTAssertEqual(failure.label, "Message saved. Conversation context couldn’t be prepared.")
    let retry = app.buttons["retry-reply"]
    XCTAssertTrue(retry.exists)
    let draft = app.descendants(matching: .any)["message-draft"].firstMatch
    draft.tap()
    draft.typeText("Preserve my next thought")
    retry.tap()
    let answer = app.staticTexts.matching(
      NSPredicate(
        format: "identifier BEGINSWITH %@ AND label CONTAINS %@",
        "assistant-message-", turn.input.text)
    ).firstMatch
    XCTAssertTrue(answer.waitForExistence(timeout: 20))
    XCTAssertEqual(draft.value as? String, "Preserve my next thought")
    XCTAssertFalse(retry.exists)
    XCTAssertFalse(failure.exists)
    let completedText = answer.label
    app.terminate()
    app.launch()
    XCTAssertTrue(answer.waitForExistence(timeout: 10))
    XCTAssertEqual(answer.label, completedText)
    XCTAssertEqual(
      app.descendants(matching: .any)["message-draft"].firstMatch.value as? String,
      "Preserve my next thought")
    XCTAssertFalse(app.buttons["retry-reply"].exists)
  }

}

private struct MemoryFixtureTurn: Decodable {
  struct Input: Decodable {
    let text: String
    let position: Int
  }
  struct Reply: Decodable { let state: String }
  let input: Input
  let reply: Reply
}
