import XCTest

@testable import Conversation

@MainActor
final class ShutdownTests: XCTestCase {
  func testShutdownDrainsExistingDraftAndDeniesNewWrites() async {
    let store = GatedDraftStore()
    let model = ConversationViewModel(transport: ScriptedTransport(), draftStore: store)
    await model.start()
    model.editDraft("Keep this checkpoint")
    await store.waitForSave()
    let release = Task {
      await store.releaseSave()
      model.editDraft("Must not overwrite after shutdown")
    }
    await model.shutdown()
    await release.value
    await model.send()
    XCTAssertEqual(model.state.connection, .stopped)
    let saved = await store.checkpoint()
    XCTAssertEqual(saved, .editable(text: "Keep this checkpoint"))
    XCTAssertTrue(model.messages.isEmpty)
  }

  func testShutdownRejectsLateHistoryAndCannotRestartOldConnection() async {
    let transport = GatedHistoryTransport()
    let model = ConversationViewModel(transport: transport, draftStore: MemoryDraftStore())
    await model.start()
    let loading = Task { await model.refreshHistory() }
    await transport.waitForHistory()
    await model.shutdown()
    let stopped = model.state
    model.editDraft("Late input")
    await model.start()
    await model.send()
    await model.refreshHistory()
    await transport.releaseHistory()
    await loading.value
    XCTAssertEqual(model.state, stopped)
  }
}

actor GatedHistoryTransport: ConversationTransport {
  private var historyGate: CheckedContinuation<HistoryPage, Never>?
  private var waiting: CheckedContinuation<Void, Never>?
  func send(_ delivery: PendingDelivery) async throws -> ConversationMessage {
    throw ConversationFailure.unavailable
  }
  func history(after: Int?) async throws -> HistoryPage {
    await withCheckedContinuation { continuation in
      historyGate = continuation
      waiting?.resume()
      waiting = nil
    }
  }
  func waitForHistory() async {
    if historyGate != nil { return }
    await withCheckedContinuation { waiting = $0 }
  }
  func releaseHistory() {
    let late = ConversationMessage(
      deliveryId: UUID(), recordId: 0, position: 0, text: "Late record")
    historyGate?.resume(returning: HistoryPage(messages: [late], nextAfter: nil))
    historyGate = nil
  }
}
