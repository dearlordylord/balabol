import XCTest

@testable import Conversation

@MainActor
final class PersistenceBarrierTests: XCTestCase {
  func testInputIntentRunsBeforePendingCheckpointAndPost() async {
    let store = GatedDraftStore(value: .editable(text: "Send this"))
    let transport = CheckpointTransport(store: store)
    var intent: UUID?
    let model = ConversationViewModel(
      transport: transport, draftStore: store, inputIntent: { intent = $0 })
    await model.start()
    let sending = Task { await model.send() }
    await store.waitForSave()
    XCTAssertNotNil(intent)
    XCTAssertEqual(intent, model.pendingDelivery?.deliveryId)
    let attempts = await transport.attempts
    XCTAssertTrue(attempts.isEmpty)
    await store.releaseSave()
    await sending.value
  }

  func testTypingCoalescesButPostWaitsForDurablePendingIdentity() async {
    let store = GatedDraftStore()
    let transport = CheckpointTransport(store: store)
    let model = ConversationViewModel(transport: transport, draftStore: store)
    await model.start()
    model.editDraft("First")
    await store.waitForSave()
    model.editDraft("Latest")
    let sending = Task { await model.send() }
    await Task.yield()
    let before = await transport.attempts
    XCTAssertTrue(before.isEmpty)
    XCTAssertTrue(model.isSavingDraft)
    await store.releaseSave()
    await sending.value
    XCTAssertNil(model.failure)
    XCTAssertEqual(model.messages.map(\.text), ["Latest"])
    let attempts = await transport.attempts
    XCTAssertEqual(attempts.map(\.text), ["Latest"])
  }
}

actor GatedDraftStore: DraftStore {
  private var value: SavedDraft
  private var loadGate: CheckedContinuation<Void, Never>?
  private var loadWaiter: CheckedContinuation<Void, Never>?
  private var saveGate: CheckedContinuation<Void, Never>?
  private var saveWaiter: CheckedContinuation<Void, Never>?
  private let blockLoad: Bool
  private var blockFirstSave: Bool
  init(
    value: SavedDraft = .editable(text: ""), blockLoad: Bool = false, blockFirstSave: Bool = true
  ) {
    self.value = value
    self.blockLoad = blockLoad
    self.blockFirstSave = blockFirstSave
  }
  func load() async throws -> SavedDraft {
    if blockLoad {
      await withCheckedContinuation { continuation in
        loadGate = continuation
        loadWaiter?.resume()
        loadWaiter = nil
      }
    }
    return value
  }
  func save(_ draft: SavedDraft) async throws {
    if blockFirstSave {
      blockFirstSave = false
      await withCheckedContinuation { continuation in
        saveGate = continuation
        saveWaiter?.resume()
        saveWaiter = nil
      }
    }
    value = draft
  }
  func waitForSave() async {
    if saveGate != nil { return }
    await withCheckedContinuation { saveWaiter = $0 }
  }
  func releaseSave() {
    saveGate?.resume()
    saveGate = nil
  }
  func waitForLoad() async {
    if loadGate != nil { return }
    await withCheckedContinuation { loadWaiter = $0 }
  }
  func releaseLoad() {
    loadGate?.resume()
    loadGate = nil
  }
  func checkpoint() -> SavedDraft { value }
}

actor CheckpointTransport: ConversationTransport {
  let store: GatedDraftStore
  var attempts: [PendingDelivery] = []
  init(store: GatedDraftStore) { self.store = store }
  func send(_ delivery: PendingDelivery) async throws -> ConversationMessage {
    attempts.append(delivery)
    guard await store.checkpoint() == .awaitingReceipt(delivery) else {
      throw ConversationFailure.invalidResponse
    }
    return ConversationMessage(
      deliveryId: delivery.deliveryId, recordId: 8, position: 0, text: delivery.text)
  }
  func history(after: Int?) async throws -> HistoryPage {
    HistoryPage(messages: [], nextAfter: nil)
  }
}
