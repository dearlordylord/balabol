import XCTest

@testable import Conversation

@MainActor
final class ConcurrencyTests: XCTestCase {
  func testConfirmedHistoryWinsOverLateSendFailure() async throws {
    let transport = DelayedConversationTransport()
    let model = ConversationViewModel(transport: transport, draftStore: MemoryDraftStore())
    await model.start()
    model.editDraft("Accepted remotely")
    let send = Task { await model.send() }
    await transport.waitForSend()
    await model.loadHistory()
    await transport.failSend()
    await send.value
    XCTAssertEqual(model.messages.map(\.text), ["Accepted remotely"])
    XCTAssertNil(model.pendingDelivery)
    XCTAssertNil(model.failure)
  }
}

actor DelayedConversationTransport: ConversationTransport {
  private var delivery: PendingDelivery?
  private var sending: CheckedContinuation<ConversationMessage, any Error>?
  private var waiting: CheckedContinuation<Void, Never>?
  func send(_ delivery: PendingDelivery) async throws -> ConversationMessage {
    self.delivery = delivery
    return try await withCheckedThrowingContinuation { continuation in
      sending = continuation
      waiting?.resume()
      waiting = nil
    }
  }
  func waitForSend() async {
    if sending != nil { return }
    await withCheckedContinuation { waiting = $0 }
  }
  func failSend() {
    sending?.resume(throwing: ConversationFailure.unavailable)
    sending = nil
  }
  func history(after: Int?) async throws -> HistoryPage {
    guard let delivery else { return HistoryPage(messages: [], nextAfter: nil) }
    return HistoryPage(
      messages: [
        ConversationMessage(
          deliveryId: delivery.deliveryId, recordId: 4, position: 0, text: delivery.text)
      ], nextAfter: nil)
  }
}

@MainActor
final class IndependentLifecycleTests: XCTestCase {
  func testHistoryFailureDoesNotOverwriteUncertainDelivery() async {
    let model = ConversationViewModel(
      transport: FailingLifecycleTransport(), draftStore: MemoryDraftStore())
    await model.start()
    model.editDraft("Uncertain")
    await model.send()
    await model.loadHistory()
    XCTAssertEqual(model.deliveryFailure, .unavailable)
    XCTAssertEqual(model.historyFailure, .invalidResponse)
    XCTAssertEqual(model.draft, "Uncertain")
    XCTAssertNotNil(model.pendingDelivery)
  }

  func testHistoryCanConfirmBeforeSavedDraftFinishesLoading() async {
    let pending = PendingDelivery(deliveryId: UUID(), text: "Already durable")
    let accepted = ConversationMessage(
      deliveryId: pending.deliveryId, recordId: 40, position: 0, text: pending.text)
    let store = GatedDraftStore(
      value: .awaitingReceipt(pending), blockLoad: true, blockFirstSave: false)
    let model = ConversationViewModel(
      transport: PageTransport(pages: [HistoryPage(messages: [accepted], nextAfter: nil)]),
      draftStore: store)
    let startup = Task { await model.start() }
    await store.waitForLoad()
    await model.loadHistory()
    XCTAssertEqual(model.messages, [accepted])
    await store.releaseLoad()
    await startup.value
    XCTAssertNil(model.pendingDelivery)
    XCTAssertEqual(model.draft, "")
    let saved = await store.checkpoint()
    XCTAssertEqual(saved, .editable(text: ""))
  }
}

actor FailingLifecycleTransport: ConversationTransport {
  func send(_ delivery: PendingDelivery) async throws -> ConversationMessage {
    throw ConversationFailure.unavailable
  }
  func history(after: Int?) async throws -> HistoryPage {
    throw ConversationFailure.invalidResponse
  }
}
