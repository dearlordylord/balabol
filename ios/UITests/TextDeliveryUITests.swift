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
    if server.waitForExistence(timeout: 5) { server.tap() }
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
}
