import Foundation
import XCTest

@testable import Conversation

@MainActor
final class LiveBackendTests: XCTestCase {
  func testTextIntentPersistsThroughProductionHTTPAndReload() async throws {
    guard let endpoint = ProcessInfo.processInfo.environment["BALABOL_TEST_SERVER"],
      let url = URL(string: endpoint)
    else {
      throw XCTSkip(
        "Set BALABOL_TEST_SERVER to an isolated real backend to run the cross-process acceptance check."
      )
    }
    let session = URLSession(configuration: .ephemeral)
    defer { session.invalidateAndCancel() }
    let transport = try HTTPConversationTransport(baseURL: url, session: session)
    let model = ConversationViewModel(transport: transport, draftStore: MemoryDraftStore())
    await model.start()
    let text = "Bonjour — English — 日本語 " + UUID().uuidString
    model.editDraft(text)
    await model.send()
    XCTAssertNil(model.failure)
    let accepted = try XCTUnwrap(model.messages.first { $0.role == .user && $0.text == text })
    XCTAssertEqual(accepted.text, text)
    XCTAssertNil(model.pendingDelivery)
    let duplicate = try await transport.send(
      PendingDelivery(deliveryId: accepted.deliveryId, text: text))
    XCTAssertEqual(duplicate, accepted)
    let reopened = ConversationViewModel(transport: transport, draftStore: MemoryDraftStore())
    await reopened.start()
    repeat {
      await reopened.loadHistory()
    } while reopened.nextBefore != nil && reopened.failure == nil
    XCTAssertNil(reopened.failure)
    XCTAssertEqual(reopened.messages.filter { $0.deliveryId == accepted.deliveryId }, [accepted])
  }
}
