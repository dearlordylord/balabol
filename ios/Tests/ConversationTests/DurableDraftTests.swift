import Foundation
import XCTest

@testable import Conversation

@MainActor
final class DurableDraftTests: XCTestCase {
  func testUncertainDraftIdentityRecoversFromRealFileAfterClientRecreation() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("draft.json")
    let transport = UncertainTransport()
    let original = ConversationViewModel(transport: transport, draftStore: FileDraftStore(url: url))
    await original.start()
    original.editDraft("Persist identity")
    await original.send()
    let identity = try XCTUnwrap(original.pendingDelivery?.deliveryId)
    let restored = ConversationViewModel(transport: transport, draftStore: FileDraftStore(url: url))
    await restored.start()
    XCTAssertEqual(restored.draft, "Persist identity")
    XCTAssertEqual(restored.pendingDelivery?.deliveryId, identity)
    await restored.send()
    XCTAssertEqual(restored.messages.first?.deliveryId, identity)
    let acceptedReload = ConversationViewModel(
      transport: transport, draftStore: FileDraftStore(url: url))
    await acceptedReload.start()
    XCTAssertEqual(acceptedReload.draft, "")
    XCTAssertNil(acceptedReload.pendingDelivery)
  }
}
