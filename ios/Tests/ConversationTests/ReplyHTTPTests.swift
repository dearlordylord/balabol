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
    let input = PendingDelivery(deliveryId: UUID(), text: "Проверка SSE " + UUID().uuidString)
    let accepted = try await sendAnnotatedRussian(input, url: url, session: session)
    XCTAssertEqual(accepted.role, .user)
    XCTAssertEqual(accepted.text, input.text)
    XCTAssertEqual(
      accepted.languageSpans,
      [LanguageSpan(language: "ru", start: 0, end: input.text.utf16.count)])
    let observation = try await transport.observeReply(for: input.deliveryId)
    defer { observation.cancel() }
    var sawProgress = false
    var completed: ConversationMessage?
    for try await snapshot in observation.events {
      XCTAssertEqual(snapshot.inputDeliveryId, input.deliveryId)
      if snapshot.state == .streaming {
        sawProgress = true
        XCTAssertFalse(snapshot.text.isEmpty)
        XCTAssertEqual(snapshot.responseLanguage, "ru")
        XCTAssertTrue(snapshot.languageSpans.allSatisfy { $0.language == "ru" })
        XCTAssertEqual(snapshot.languageSpans.first?.start, 0)
        XCTAssertEqual(snapshot.languageSpans.last?.end, snapshot.text.utf16.count)
      }
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
    XCTAssertEqual(receipt.text, "Это демонстрационный ответ.")
    XCTAssertEqual(receipt.languageSpans.first?.start, 0)
    XCTAssertEqual(receipt.languageSpans.last?.end, receipt.text.utf16.count)
    XCTAssertTrue(receipt.languageSpans.allSatisfy { $0.language == "ru" })
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let reopened = ConversationViewModel(
      transport: transport,
      draftStore: FileDraftStore(url: directory.appendingPathComponent("draft.json")))
    await reopened.start()
    repeat {
      await reopened.loadHistory()
    } while reopened.nextBefore != nil && reopened.historyFailure == nil
    XCTAssertEqual(reopened.messages.filter { $0.responseId == receipt.responseId }, [receipt])
    XCTAssertNil(reopened.historyFailure)
    await reopened.shutdown()
  }
  func testRealTextInterruptionPersistsPartialAndNextReply() async throws {
    guard let endpoint = ProcessInfo.processInfo.environment["BALABOL_TEST_REPLY_SERVER"],
      let url = URL(string: endpoint)
    else { throw XCTSkip("Set BALABOL_TEST_REPLY_SERVER to an isolated fake-provider backend.") }
    let session = URLSession(configuration: .ephemeral)
    defer { session.invalidateAndCancel() }
    let transport = try HTTPConversationTransport(baseURL: url, session: session)
    let first = PendingDelivery(deliveryId: UUID(), text: "Прервать HTTP " + UUID().uuidString)
    _ = try await sendAnnotatedRussian(first, url: url, session: session)
    let old = try await transport.observeReply(for: first.deliveryId)
    defer { old.cancel() }
    var partial: ReplySnapshot?
    for try await snapshot in old.events {
      if snapshot.state == .streaming {
        partial = snapshot
        break
      }
    }
    let generated = try XCTUnwrap(partial)
    XCTAssertEqual(generated.inputDeliveryId, first.deliveryId)
    XCTAssertEqual(generated.responseLanguage, "ru")
    XCTAssertFalse(generated.text.isEmpty)
    XCTAssertLessThan(generated.text.utf16.count, "Это демонстрационный ответ.".utf16.count)
    XCTAssertEqual(generated.languageSpans.first?.start, 0)
    XCTAssertEqual(generated.languageSpans.last?.end, generated.text.utf16.count)
    XCTAssertTrue(generated.languageSpans.allSatisfy { $0.language == "ru" })
    let second = PendingDelivery(deliveryId: UUID(), text: "Correction HTTP " + UUID().uuidString)
    let accepted = try await transport.send(second)
    let next = try await transport.observeReply(for: second.deliveryId)
    defer { next.cancel() }
    var completed: ConversationMessage?
    for try await snapshot in next.events {
      if snapshot.state == .completed {
        completed = snapshot.receipt
        break
      }
      XCTAssertNotEqual(snapshot.state, .failed)
    }
    let answer = try XCTUnwrap(completed)
    XCTAssertEqual(answer.text, "This is a fixture reply.")
    XCTAssertEqual(answer.languageSpans.first?.start, 0)
    XCTAssertEqual(answer.languageSpans.last?.end, answer.text.utf16.count)
    XCTAssertTrue(answer.languageSpans.allSatisfy { $0.language == "en" })
    XCTAssertTrue(accepted.languageSpans.isEmpty)
    let restored = ConversationViewModel(transport: transport, draftStore: MemoryDraftStore())
    await restored.start()
    repeat {
      await restored.loadHistory()
    } while restored.nextBefore != nil && restored.historyFailure == nil
    let interrupted = try XCTUnwrap(
      restored.messages.first { $0.responseId == generated.responseId })
    XCTAssertEqual(interrupted.outcome, .interrupted)
    XCTAssertEqual(interrupted.inputDeliveryId, first.deliveryId)
    XCTAssertTrue(interrupted.languageSpans.allSatisfy { $0.language == "ru" })
    XCTAssertEqual(interrupted.languageSpans.last?.end, interrupted.text.utf16.count)
    XCTAssertTrue(interrupted.text.hasPrefix(generated.text))
    XCTAssertLessThan(interrupted.position, accepted.position)
    XCTAssertLessThan(accepted.position, answer.position)
    XCTAssertEqual(restored.messages.filter { $0.deliveryId == second.deliveryId }, [accepted])
    XCTAssertTrue(restored.messages.contains(answer))
    await restored.shutdown()
  }

  /// The public wire accepts annotations even though the keyboard sender leaves
  /// them absent. RU has two real fixture deltas, so a slow isolated reply host
  /// supplies a genuine partial window instead of changing production chunks.
  private func sendAnnotatedRussian(_ input: PendingDelivery, url: URL, session: URLSession)
    async throws -> ConversationMessage
  {
    struct Body: Encodable {
      let deliveryId: UUID
      let text: String
      let languageSpans: [LanguageSpan]
    }
    var request = URLRequest(url: url.appendingPathComponent("conversation/messages"))
    request.httpMethod = "POST"
    request.timeoutInterval = 15
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONEncoder().encode(
      Body(
        deliveryId: input.deliveryId, text: input.text,
        languageSpans: [LanguageSpan(language: "ru", start: 0, end: input.text.utf16.count)]))
    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      throw ConversationFailure.invalidResponse
    }
    return try JSONDecoder().decode(ConversationMessage.self, from: data)
  }

}
