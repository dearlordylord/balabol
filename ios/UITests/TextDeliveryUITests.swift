import Foundation
import XCTest

@MainActor
final class TextDeliveryUITests: XCTestCase {
  func testFreshSimulatorOpensConversationWithoutServerSetup() throws {
    #if !targetEnvironment(simulator)
      throw XCTSkip("Automatic localhost setup is only available on Simulator.")
    #endif
    let app = XCUIApplication()
    defer { app.terminate() }
    app.launchEnvironment["BALABOL_UI_TEST_NAMESPACE"] = UUID().uuidString
    app.launch()
    XCTAssertTrue(app.textFields["message-draft"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["send-message"].exists)
    XCTAssertFalse(app.textFields["server-url"].exists)
    XCTAssertFalse(app.buttons["Connect"].exists)
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
    let draft = app.textFields["message-draft"]
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
    XCTAssertEqual(app.textFields["message-draft"].value as? String, "Retain this draft")
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
    let draft = app.textFields["message-draft"]
    XCTAssertTrue(draft.waitForExistence(timeout: 5))
    let input = "UI reply " + UUID().uuidString
    draft.tap()
    draft.typeText(input)
    app.buttons["send-message"].tap()
    XCTAssertTrue(app.staticTexts["demo-provider"].exists)
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
    for _ in 0..<5 {
      if answer.waitForExistence(timeout: 1) { break }
      let more = app.buttons["Load more"]
      if !more.exists { app.swipeUp() }
      if more.waitForExistence(timeout: 2) { more.tap() }
    }
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
    let draft = app.textFields["message-draft"]
    XCTAssertTrue(draft.waitForExistence(timeout: 5))
    let first = "First UI " + UUID().uuidString.prefix(8) + " " + String(repeating: "x", count: 136)
    let second = "Fix UI " + UUID().uuidString.prefix(8)
    draft.tap()
    draft.typeText(first)
    app.buttons["send-message"].tap()
    let progress = app.staticTexts["reply-progress"]
    XCTAssertTrue(progress.waitForExistence(timeout: 15))
    let partial = progress.label
    let firstRow = app.staticTexts.matching(
      NSPredicate(
        format: "identifier BEGINSWITH %@ AND label == %@", "message-", first)
    ).firstMatch
    let firstPosition = try XCTUnwrap(Int(firstRow.identifier.split(separator: "-").last ?? ""))
    draft.tap()
    draft.typeText(second)
    XCTAssertTrue(app.buttons["send-message"].isEnabled)
    app.buttons["send-message"].tap()
    let interrupted = app.staticTexts["interrupted-message-\(firstPosition + 1)"]
    XCTAssertTrue(interrupted.waitForExistence(timeout: 15))
    let retained = app.staticTexts["assistant-message-\(firstPosition + 1)"]
    XCTAssertTrue(retained.exists)
    XCTAssertTrue(retained.label.hasPrefix(partial))
    let answer = app.staticTexts.matching(
      NSPredicate(
        format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "assistant-message-", second)
    ).firstMatch
    XCTAssertTrue(answer.waitForExistence(timeout: 25))
    let answerText = answer.label
    app.terminate()
    app.launch()
    // Relaunch retains bounded history paging; locate this later durable turn
    // through the existing Load more action rather than draining at startup.
    for _ in 0..<5 {
      if answer.waitForExistence(timeout: 1) { break }
      let more = app.buttons["Load more"]
      if !more.exists { app.swipeUp() }
      if more.waitForExistence(timeout: 2) { more.tap() }
    }
    XCTAssertTrue(answer.waitForExistence(timeout: 10))
    XCTAssertEqual(answer.label, answerText)
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
    let draft = app.textFields["message-draft"]
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
    XCTAssertEqual(app.textFields["message-draft"].value as? String, "Preserve my next thought")
    XCTAssertFalse(app.buttons["retry-reply"].exists)
  }

}

private struct MemoryFixtureTurn: Decodable {
  struct Input: Decodable { let text: String }
  struct Reply: Decodable { let state: String }
  let input: Input
  let reply: Reply
}
