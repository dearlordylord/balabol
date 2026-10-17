import XCTest
@testable import Conversation

final class DeliveryFailureTests: XCTestCase {
  func testFailedReceiptRoundTripsWithOriginalCauseAndCannotDecodeAsUserInterruption() throws {
    let input = UUID()
    let response = UUID()
    let failure = ReplyFailure(code: .audioUnavailable,
      message: "Reply audio readiness exceeded its deadline", reason: "ReadinessDeadline")
    let receipt = ConversationMessage(deliveryId: response, recordId: 1, position: 1,
      text: "Saved reply", role: .assistant, responseId: response, inputDeliveryId: input,
      outcome: .interrupted, failure: failure)
    let snapshot = ReplySnapshot(responseId: response, inputDeliveryId: input,
      sequence: 1, state: .failed, text: receipt.text, error: failure, receipt: receipt)
    XCTAssertTrue(snapshot.isValid)
    let restored = try JSONDecoder().decode(ReplySnapshot.self,
      from: JSONEncoder().encode(snapshot))
    XCTAssertEqual(restored.error, failure)
    XCTAssertEqual(restored.receipt?.failure, failure)
    let disguised = ReplySnapshot(responseId: response, inputDeliveryId: input,
      sequence: 1, state: .interrupted, text: receipt.text, receipt: receipt)
    XCTAssertFalse(disguised.isValid)
  }
}
