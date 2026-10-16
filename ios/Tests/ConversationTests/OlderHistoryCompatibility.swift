@testable import Conversation

// Focused delivery/reply fakes contain an entire tiny transcript, not a paged
// ledger. A forward page is usable as a latest snapshot only when it proves EOF.
// Directional pagination tests implement olderHistory explicitly.
extension ConversationTransport {
  func olderHistory(before: Int?) async throws -> OlderHistoryPage {
    guard before == nil else { throw ConversationFailure.invalidInput }
    let snapshot = try await history(after: nil)
    guard snapshot.nextAfter == nil else { throw ConversationFailure.invalidResponse }
    return OlderHistoryPage(messages: snapshot.messages, nextBefore: nil)
  }
}
