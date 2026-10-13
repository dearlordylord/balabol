import Foundation
import XCTest

@testable import Conversation

@MainActor
final class ReplyHTTPTests: XCTestCase {
  func testRealSSEProgressAndCompletedReplyRecoverThroughHistory() async throws {
    guard let endpoint = ProcessInfo.processInfo.environment["BALABOL_TEST_REPLY_SERVER"],
      let url = URL(string: endpoint)
    else {
      throw XCTSkip("Set BALABOL_TEST_REPLY_SERVER to an isolated fake-provider backend.")
    }
    let session = URLSession(configuration: .ephemeral)
    defer { session.invalidateAndCancel() }
    let transport = try HTTPConversationTransport(baseURL: url, session: session)
    let input = PendingDelivery(deliveryId: UUID(), text: "Swift SSE " + UUID().uuidString)
    let accepted = try await transport.send(input)
    XCTAssertEqual(accepted.role, .user)
    let observation = try await transport.observeReply(for: input.deliveryId)
    defer { observation.cancel() }
    var sawProgress = false
    var completed: ConversationMessage?
    for try await snapshot in observation.events {
      XCTAssertEqual(snapshot.inputDeliveryId, input.deliveryId)
      if snapshot.state == .streaming { sawProgress = true }
      if snapshot.state == .completed {
        completed = snapshot.receipt
        break
      }
      if snapshot.state == .failed {
        XCTFail("Fake provider failed: \(snapshot.error?.code.rawValue ?? "unknown")")
        break
      }
    }
    let receipt = try XCTUnwrap(completed)
    XCTAssertTrue(sawProgress)
    XCTAssertTrue(receipt.text.contains(input.text))
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let reopened = ConversationViewModel(
      transport: transport,
      draftStore: FileDraftStore(url: directory.appendingPathComponent("draft.json")))
    await reopened.start()
    repeat {
      await reopened.loadHistory()
    } while reopened.nextAfter != nil && reopened.historyFailure == nil
    XCTAssertEqual(reopened.messages.filter { $0.responseId == receipt.responseId }, [receipt])
    XCTAssertNil(reopened.historyFailure)
    await reopened.shutdown()
  }
}
