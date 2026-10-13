import XCTest

@testable import Conversation

@MainActor
final class ConversationViewModelTests: XCTestCase {
  func testReceiptConfirmsTranscriptAndClearsDraft() async throws {
    let transport = ScriptedTransport()
    let model = ConversationViewModel(transport: transport, draftStore: MemoryDraftStore())
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
