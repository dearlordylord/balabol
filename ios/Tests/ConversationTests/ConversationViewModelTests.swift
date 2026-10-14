import XCTest

@testable import Conversation

@MainActor
final class ConversationViewModelTests: XCTestCase {
  func testVoiceReceiptPreservesEditableDraftAndHistoryCursor() async {
    let model = ConversationViewModel(
      transport: CursorConversationTransport(), draftStore: MemoryDraftStore())
    await model.start()
    await model.loadHistory()
    model.editDraft("Unsent text remains mine")
    await model.flushDraft()
    let voice = ConversationMessage(
      deliveryId: UUID(), recordId: 20, position: 5, text: "Accepted voice")
    model.acceptVoiceReceipt(voice)
    model.acceptVoiceReceipt(voice)
    XCTAssertEqual(model.messages.map(\.text), ["First", "Accepted voice"])
    XCTAssertEqual(model.draft, "Unsent text remains mine")
    XCTAssertEqual(model.state.historyCursor, 0)
    XCTAssertNil(model.pendingDelivery)
    await model.shutdown()
  }

  func testReceiptConfirmsTranscriptAndClearsDraft() async throws {
    let transport = ScriptedTransport()
    let model = ConversationViewModel(transport: transport, draftStore: MemoryDraftStore())
    await model.start()
    model.editDraft("Bonjour")
    await model.send()
    XCTAssertEqual(model.messages.map(\.text), ["Bonjour"])
    XCTAssertEqual(model.draft, "")
    XCTAssertNil(model.pendingDelivery)
  }
}

actor ScriptedTransport: ConversationTransport {
  func send(_ delivery: PendingDelivery) async throws -> ConversationMessage {
    ConversationMessage(
      deliveryId: delivery.deliveryId, recordId: 7, position: 0, text: delivery.text)
  }
  func history(after: Int?) async throws -> HistoryPage {
    HistoryPage(messages: [], nextAfter: nil)
  }
}
