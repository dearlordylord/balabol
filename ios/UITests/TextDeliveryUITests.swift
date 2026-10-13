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
    XCTAssertTrue(answer.waitForExistence(timeout: 10))
    XCTAssertEqual(answer.label, completedText)
  }

}
