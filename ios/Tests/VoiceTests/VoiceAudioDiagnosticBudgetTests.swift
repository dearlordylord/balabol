import XCTest

@testable import Voice

#if DEBUG
  final class VoiceAudioDiagnosticBudgetTests: XCTestCase {
    func testLifecycleStagesAreBoundedIndependentlyAndWindowsShareOneRunBudget() {
      var budget = VoiceAudioDiagnosticBudget()
      for _ in 0..<12 { XCTAssertTrue(budget.admit("route-change")) }
      XCTAssertFalse(budget.admit("route-change"))
      XCTAssertTrue(budget.admit("app-background"))
      for index in 0..<30 {
        XCTAssertTrue(
          budget.admit(
            index.isMultiple(of: 2) ? "capture-window" : "playback-window", periodic: true))
      }
      XCTAssertFalse(budget.admit("capture-window", periodic: true))
      XCTAssertFalse(budget.admit("playback-window", periodic: true))
    }
  }
#endif
