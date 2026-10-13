import XCTest

@testable import Conversation

@MainActor
final class RejectionTests: XCTestCase {
  func testDefinitiveRejectionKeepsEditableDraftAndNextSendUsesFreshIdentity() async {
    for code in ["InvalidInput", "DeliveryConflict"] {
      let transport = RejectionTransport(code: code)
      let model = ConversationViewModel(transport: transport, draftStore: MemoryDraftStore())
      await model.start()
      model.editDraft("Original")
      await model.send()
      XCTAssertNil(model.pendingDelivery)
      XCTAssertEqual(model.draft, "Original")
      model.editDraft("Corrected")
      await model.send()
      XCTAssertEqual(model.messages.map(\.text), ["Corrected"])
      let attempts = await transport.attempts
      XCTAssertEqual(attempts.map(\.text), ["Original", "Corrected"])
      XCTAssertNotEqual(attempts.first?.deliveryId, attempts.last?.deliveryId)
    }
  }
}

actor RejectionTransport: ConversationTransport {
  var attempts: [PendingDelivery] = []
  private let code: String
  init(code: String) { self.code = code }
  func send(_ delivery: PendingDelivery) async throws -> ConversationMessage {
    attempts.append(delivery)
    if attempts.count == 1 { throw ConversationFailure.rejected(code: code, message: "Rejected") }
    return ConversationMessage(
      deliveryId: delivery.deliveryId, recordId: 4, position: 0, text: delivery.text)
  }
  func history(after: Int?) async throws -> HistoryPage {
    HistoryPage(messages: [], nextAfter: nil)
  }
}
