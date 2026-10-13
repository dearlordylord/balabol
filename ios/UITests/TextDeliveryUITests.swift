import XCTest

@MainActor
final class TextDeliveryUITests: XCTestCase {
  func testUnreachableServerRetainsDraftAcrossRelaunch() {
    let app = XCUIApplication()
    app.launch()
    let server = app.buttons["Server"]
    if server.waitForExistence(timeout: 2), server.isEnabled { server.tap() }
    let address = app.textFields["http://100.x.x.x:3000"]
    XCTAssertTrue(address.waitForExistence(timeout: 5))
    address.tap()
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
