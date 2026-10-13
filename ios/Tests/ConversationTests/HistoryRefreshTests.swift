import XCTest

@testable import Conversation

@MainActor
final class HistoryRefreshTests: XCTestCase {
  func testEOFForegroundRefreshUsesFetchedCursorNotDirectReceiptPosition() async {
    let transport = CursorConversationTransport()
    let model = ConversationViewModel(transport: transport, draftStore: MemoryDraftStore())
    await model.start()
    await model.loadHistory()
    model.editDraft("Mine")
    await model.send()
    XCTAssertEqual(model.messages.map(\.position), [0, 2])
    XCTAssertEqual(model.state.historyCursor, 0)
    await model.refreshHistory()
    XCTAssertEqual(model.messages.map(\.text), ["First", "Missing row", "Mine"])
    await model.refreshHistory()
    XCTAssertEqual(model.messages.map(\.text), ["First", "Missing row", "Mine", "Added later"])
    let cursors = await transport.cursors
    XCTAssertEqual(cursors, [nil, 0, 2])
    XCTAssertNil(model.historyFailure)
  }
}

actor CursorConversationTransport: ConversationTransport {
  var cursors: [Int?] = []
  private let first = ConversationMessage(
    deliveryId: UUID(), recordId: 10, position: 0, text: "First")
  private let middle = ConversationMessage(
    deliveryId: UUID(), recordId: 11, position: 1, text: "Missing row")
  private let later = ConversationMessage(
    deliveryId: UUID(), recordId: 13, position: 3, text: "Added later")
  private var accepted: ConversationMessage?
  func send(_ delivery: PendingDelivery) async throws -> ConversationMessage {
    let receipt = ConversationMessage(
      deliveryId: delivery.deliveryId, recordId: 12, position: 2, text: delivery.text)
    accepted = receipt
    return receipt
  }
  func history(after: Int?) async throws -> HistoryPage {
    cursors.append(after)
    if after == nil { return HistoryPage(messages: [first], nextAfter: nil) }
    if after == 0, let accepted {
      return HistoryPage(messages: [middle, accepted], nextAfter: nil)
    }
    if after == 2 { return HistoryPage(messages: [later], nextAfter: nil) }
    throw ConversationFailure.invalidResponse
  }
}
