import XCTest

@testable import Conversation

@MainActor
final class HistoryTests: XCTestCase {
  func testDurableHistoryResolvesAnUncertainPendingDelivery() async throws {
    let id = UUID()
    let store = MemoryDraftStore()
    try await store.save(
      SavedDraft.awaitingReceipt(PendingDelivery(deliveryId: id, text: "Already saved")))
    let message = ConversationMessage(
      deliveryId: id, recordId: 4, position: 0, text: "Already saved")
    let model = ConversationViewModel(
      transport: PageTransport(pages: [HistoryPage(messages: [message], nextAfter: nil)]),
      draftStore: store)
    await model.start()
    await model.loadHistory()
    XCTAssertEqual(model.messages, [message])
    XCTAssertEqual(model.draft, "")
    XCTAssertNil(model.pendingDelivery)
  }
}

actor PageTransport: ConversationTransport {
  private var pages: [HistoryPage]
  private(set) var cursors: [Int?] = []
  init(pages: [HistoryPage]) { self.pages = pages }
  func send(_ delivery: PendingDelivery) async throws -> ConversationMessage {
    throw ConversationFailure.unavailable
  }
  func history(after: Int?) async throws -> HistoryPage {
    cursors.append(after)
    return pages.removeFirst()
  }
}

@MainActor
final class PagingTests: XCTestCase {
  func testPagedHistoryUsesLedgerCursorAndKeepsOrderWithoutDuplicates() async {
    let first = ConversationMessage(deliveryId: UUID(), recordId: 9, position: 0, text: "First")
    let second = ConversationMessage(deliveryId: UUID(), recordId: 30, position: 1, text: "Second")
    let transport = PageTransport(pages: [
      HistoryPage(messages: [first], nextAfter: 0), HistoryPage(messages: [second], nextAfter: nil),
    ])
    let model = ConversationViewModel(transport: transport, draftStore: MemoryDraftStore())
    await model.start()
    await model.loadHistory()
    await model.loadHistory()
    XCTAssertEqual(model.messages.map(\.text), ["First", "Second"])
    let cursors = await transport.cursors
    XCTAssertEqual(cursors, [nil, 0])
    XCTAssertNil(model.failure)
  }
  func testConflictingHistoryReceiptCannotClearPendingDraft() async throws {
    let id = UUID()
    let store = MemoryDraftStore()
    try await store.save(
      SavedDraft.awaitingReceipt(PendingDelivery(deliveryId: id, text: "Original")))
    let conflict = ConversationMessage(deliveryId: id, recordId: 4, position: 0, text: "Changed")
    let model = ConversationViewModel(
      transport: PageTransport(pages: [HistoryPage(messages: [conflict], nextAfter: nil)]),
      draftStore: store)
    await model.start()
    await model.loadHistory()
    XCTAssertEqual(model.failure, .invalidResponse)
    XCTAssertEqual(model.draft, "Original")
    XCTAssertTrue(model.messages.isEmpty)
  }
}

@MainActor
final class InvalidHistoryTests: XCTestCase {
  func testEmptyOrOversizedMessagesCannotEnterConfirmedTranscript() async {
    for text in ["", String(repeating: "x", count: 100_001)] {
      let invalid = ConversationMessage(deliveryId: UUID(), recordId: 1, position: 0, text: text)
      let model = ConversationViewModel(
        transport: PageTransport(pages: [HistoryPage(messages: [invalid], nextAfter: nil)]),
        draftStore: MemoryDraftStore())
      await model.start()
      await model.loadHistory()
      XCTAssertEqual(model.failure, .invalidResponse)
      XCTAssertTrue(model.messages.isEmpty)
    }
  }
}
