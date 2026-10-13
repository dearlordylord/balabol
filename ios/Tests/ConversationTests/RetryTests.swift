import XCTest

@testable import Conversation

@MainActor
final class RetryTests: XCTestCase {
  func testUncertainDeliverySurvivesRelaunchAndRetriesSameIdentity() async throws {
    let transport = UncertainTransport()
    let store = MemoryDraftStore()
    let first = ConversationViewModel(transport: transport, draftStore: store)
    await first.start()
    first.editDraft("Retry me")
    await first.send()
    let identity = try XCTUnwrap(first.pendingDelivery?.deliveryId)
    XCTAssertEqual(first.draft, "Retry me")
    XCTAssertTrue(first.messages.isEmpty)
    let reopened = ConversationViewModel(transport: transport, draftStore: store)
    await reopened.start()
    reopened.editDraft("Different payload")
    XCTAssertEqual(reopened.draft, "Retry me")
    await reopened.send()
    XCTAssertEqual(reopened.messages.first?.deliveryId, identity)
    XCTAssertNil(reopened.pendingDelivery)
    let attempts = await transport.attempts
    XCTAssertEqual(attempts.map(\.deliveryId), [identity, identity])
  }
}

actor UncertainTransport: ConversationTransport {
  var attempts: [PendingDelivery] = []
  func send(_ delivery: PendingDelivery) async throws -> ConversationMessage {
    attempts.append(delivery)
    if attempts.count == 1 { throw ConversationFailure.unavailable }
    return ConversationMessage(
      deliveryId: delivery.deliveryId, recordId: 8, position: 0, text: delivery.text)
  }
  func history(after: Int?) async throws -> HistoryPage {
    HistoryPage(messages: [], nextAfter: nil)
  }
}

@MainActor
final class DraftRecoveryTests: XCTestCase {
  func testUnreadablePendingStateCannotBeOverwrittenOrSent() async {
    let transport = UncertainTransport()
    let store = UnreadableDraftStore()
    let model = ConversationViewModel(transport: transport, draftStore: store)
    await model.start()
    model.editDraft("New message")
    await model.send()
    XCTAssertEqual(model.failure, .draftStorageUnavailable)
    let savedToStore = await store.saved
    XCTAssertFalse(savedToStore)
    let attempts = await transport.attempts
    XCTAssertTrue(attempts.isEmpty)
  }
}

actor UnreadableDraftStore: DraftStore {
  var saved = false
  func load() throws -> SavedDraft { throw ConversationFailure.draftStorageUnavailable }
  func save(_ draft: SavedDraft) throws { saved = true }
}

@MainActor
final class DraftSaveFailureTests: XCTestCase {
  func testUncertainLocalCheckpointRequiresReloadBeforeAnotherIdentity() async throws {
    let transport = UncertainTransport()
    let store = AmbiguousSaveStore()
    let model = ConversationViewModel(transport: transport, draftStore: store)
    await model.start()
    model.editDraft("Checkpoint")
    await model.flushDraft()
    await store.failNextCheckpoint()
    await model.send()
    XCTAssertFalse(model.draftStorageReady)
    let attempts = await transport.attempts
    XCTAssertTrue(attempts.isEmpty)
    let saved = try await store.load()
    await model.reloadDraft()
    XCTAssertEqual(model.pendingDelivery?.deliveryId, saved.pending?.deliveryId)
  }
}

actor AmbiguousSaveStore: DraftStore {
  var failNextSave = false
  func failNextCheckpoint() { failNextSave = true }
  private var value = SavedDraft.editable(text: "")
  func load() throws -> SavedDraft { value }
  func save(_ draft: SavedDraft) throws {
    value = draft
    if failNextSave {
      failNextSave = false
      throw ConversationFailure.draftStorageUnavailable
    }
  }
}
