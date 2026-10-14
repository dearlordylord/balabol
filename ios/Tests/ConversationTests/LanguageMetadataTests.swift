import Foundation
import XCTest

@testable import Conversation

@MainActor final class LanguageMetadataTests: XCTestCase {
  func testLegacyReceiptAndReplyDecodeWithoutInventedLanguage() throws {
    let message = try decodeMessage(text: "Legacy", spans: nil)
    let encoded =
      try JSONSerialization.jsonObject(with: JSONEncoder().encode(message)) as? [String: Any]
    XCTAssertEqual((encoded?["languageSpans"] as? [[String: Any]])?.count, 0)
  }
  func testMixedReceiptRoundTripsSparseUTF16Annotations() throws {
    let spans: [[String: Any]] = [
      ["language": "ru", "start": 0, "end": 6],
      ["language": "fr", "start": 7, "end": 12],
      ["language": "en", "start": 13, "end": 15],
    ]
    let message = try decodeMessage(text: "Привет salut hi", spans: spans)
    let encoded =
      try JSONSerialization.jsonObject(with: JSONEncoder().encode(message)) as? [String: Any]
    XCTAssertEqual((encoded?["languageSpans"] as? [[String: Any]])?.count, 3)
    XCTAssertEqual(
      (encoded?["languageSpans"] as? [[String: Any]])?.last?["language"] as? String, "en")
  }
  func testMalformedReceiptAnnotationsAreContractFailures() throws {
    let cases: [[[String: Any]]] = [
      [["language": "ru", "start": 0, "end": 3]],
      [["language": "en", "start": 1, "end": 2]],
      [["language": "en", "start": 0, "end": 0]],
      [["language": "EN-us", "start": 0, "end": 2]],
      [["language": "bad_tag", "start": 0, "end": 2]],
      [["language": "en", "start": 0, "end": 2], ["language": "fr", "start": 1, "end": 2]],
    ]
    for spans in cases { XCTAssertThrowsError(try decodeMessage(text: "😀", spans: spans)) }
  }
  func testScriptRegionExtensionsAndJapaneseMetadataRemainVerbatim() throws {
    for tag in ["ru", "fr", "en", "ja", "pt-BR", "zh-Hant-TW", "en-Latn-US", "de-u-co-phonebk"] {
      XCTAssertTrue(LanguageSpan.isValidLanguageTag(tag), tag)
    }
    XCTAssertFalse(LanguageSpan.isValidLanguageTag("pt-br"))
    XCTAssertFalse(LanguageSpan.isValidLanguageTag("en-u"))
    XCTAssertFalse(LanguageSpan.isValidLanguageTag("en-US-u-ca-gregory-u-nu-latn"))
    XCTAssertTrue(LanguageSpan.areValid([LanguageSpan(language: "ja", start: 0, end: 2)], for: "😀"))
    XCTAssertEqual(
      LanguageSpan.displayNames(
        [
          LanguageSpan(language: "ru", start: 0, end: 1),
          LanguageSpan(language: "fr", start: 1, end: 2),
          LanguageSpan(language: "ru", start: 2, end: 3),
        ], locale: Locale(identifier: "en")), "Russian · French")
  }
  func testReplyMetadataProgressAndInterruptedReceiptProjectWithoutChangingDraft() async throws {
    let transport = LanguageReplyTransport()
    let store = MemoryDraftStore()
    try await store.save(.editable(text: "Independent draft"))
    let model = ConversationViewModel(transport: transport, draftStore: store)
    await model.start()
    let input = await transport.input
    XCTAssertEqual(model.messages, [input])
    let spans = [
      LanguageSpan(language: "fr", start: 0, end: 7),
      LanguageSpan(language: "en", start: 8, end: 13),
    ]
    let streaming = await transport.snapshot(text: "Bonjour Hello", spans: spans)
    await transport.emit(streaming)
    await settle { model.replyText == "Bonjour Hello" }
    XCTAssertEqual(model.state.replyLanguageSpans, spans)
    XCTAssertEqual(model.draft, "Independent draft")
    XCTAssertNil(model.state.historyCursor)
    let receipt = await transport.interruptedReceipt(spans: spans)
    await transport.emit(
      ReplySnapshot(
        responseId: streaming.responseId,
        inputDeliveryId: input.deliveryId, sequence: 2, state: .interrupted,
        text: receipt.text, receipt: receipt, languageSpans: spans, responseLanguage: "en"))
    await settle { model.messages.last == receipt }
    XCTAssertEqual(model.state.replyLanguageSpans, spans)
    XCTAssertEqual(model.messages.last?.languageSpans, spans)
    XCTAssertEqual(model.draft, "Independent draft")
    XCTAssertNil(model.state.historyCursor)
    await model.shutdown()
  }

  func testInvalidReplySpanOrResponseLanguageIsRejectedAndLegacyReplyIsUnannotated() throws {
    let input = UUID()
    let response = UUID()
    var object: [String: Any] = [
      "responseId": response.uuidString, "inputDeliveryId": input.uuidString,
      "sequence": 1, "state": "Streaming", "text": "😀", "error": NSNull(), "receipt": NSNull(),
    ]
    let legacy = try JSONDecoder().decode(
      ReplySnapshot.self,
      from: JSONSerialization.data(withJSONObject: object))
    XCTAssertTrue(legacy.languageSpans.isEmpty)
    XCTAssertNil(legacy.responseLanguage)
    object["languageSpans"] = [["language": "ja", "start": 0, "end": 1]]
    XCTAssertThrowsError(
      try JSONDecoder().decode(
        ReplySnapshot.self,
        from: JSONSerialization.data(withJSONObject: object)))
    object["languageSpans"] = [["language": "ja", "start": 0, "end": 2]]
    object["responseLanguage"] = "bad_tag"
    XCTAssertThrowsError(
      try JSONDecoder().decode(
        ReplySnapshot.self,
        from: JSONSerialization.data(withJSONObject: object)))
  }

  func testTerminalEnvelopeRejectsContradictoryReceiptAnnotationsAndAcceptsMatchingOrLegacy() throws
  {
    for phase in [ReplySnapshot.Phase.completed, .interrupted] {
      let input = UUID()
      let response = UUID()
      let spans = [LanguageSpan(language: "en", start: 0, end: 5)]
      for contradictory in [
        [LanguageSpan(language: "fr", start: 0, end: 5)],
        [LanguageSpan(language: "en", start: 1, end: 5)],
      ] {
        XCTAssertTrue(LanguageSpan.areValid(spans, for: "Hello"))
        XCTAssertTrue(LanguageSpan.areValid(contradictory, for: "Hello"))
        let receipt = ConversationMessage(
          deliveryId: response, recordId: 21, position: 21,
          text: "Hello", role: .assistant, responseId: response, inputDeliveryId: input,
          outcome: phase == .interrupted ? .interrupted : .completed, languageSpans: contradictory)
        let envelope = ReplySnapshot(
          responseId: response, inputDeliveryId: input,
          sequence: 2, state: phase, text: "Hello", receipt: receipt, languageSpans: spans)
        XCTAssertThrowsError(
          try JSONDecoder().decode(
            ReplySnapshot.self,
            from: JSONEncoder().encode(envelope)))
      }
      let receipt = ConversationMessage(
        deliveryId: response, recordId: 21, position: 21,
        text: "Hello", role: .assistant, responseId: response, inputDeliveryId: input,
        outcome: phase == .interrupted ? .interrupted : .completed, languageSpans: spans)
      let matching = ReplySnapshot(
        responseId: response, inputDeliveryId: input,
        sequence: 2, state: phase, text: "Hello", receipt: receipt, languageSpans: spans)
      let decoded = try JSONDecoder().decode(
        ReplySnapshot.self, from: JSONEncoder().encode(matching))
      XCTAssertEqual(decoded.languageSpans, spans)
      XCTAssertEqual(decoded.receipt?.languageSpans, spans)
      var legacy = try XCTUnwrap(
        JSONSerialization.jsonObject(with: JSONEncoder().encode(matching)) as? [String: Any])
      legacy.removeValue(forKey: "languageSpans")
      var legacyReceipt = try XCTUnwrap(legacy["receipt"] as? [String: Any])
      legacyReceipt.removeValue(forKey: "languageSpans")
      legacy["receipt"] = legacyReceipt
      let legacyDecoded = try JSONDecoder().decode(
        ReplySnapshot.self,
        from: JSONSerialization.data(withJSONObject: legacy))
      XCTAssertTrue(legacyDecoded.languageSpans.isEmpty)
      XCTAssertEqual(legacyDecoded.receipt?.languageSpans, [])
    }
  }

  private func settle(_ ready: () -> Bool) async {
    for _ in 0..<300 {
      if ready() { return }
      try? await Task.sleep(for: .milliseconds(5))
    }
    XCTFail("Language projection did not settle")
  }

  private func decodeMessage(text: String, spans: [[String: Any]]?) throws -> ConversationMessage {
    var object: [String: Any] = [
      "deliveryId": UUID().uuidString, "recordId": 1, "position": 1, "text": text,
      "role": "user", "responseId": NSNull(), "inputDeliveryId": NSNull(),
    ]
    if let spans { object["languageSpans"] = spans }
    return try JSONDecoder().decode(
      ConversationMessage.self,
      from: JSONSerialization.data(withJSONObject: object))
  }
}

private actor LanguageReplyTransport: ConversationTransport {
  let input = ConversationMessage(
    deliveryId: UUID(), recordId: 1, position: 1, text: "Bonjour Hello",
    languageSpans: [
      LanguageSpan(language: "fr", start: 0, end: 7),
      LanguageSpan(language: "en", start: 8, end: 13),
    ])
  private let response = UUID()
  private let stream = AsyncThrowingStream<ReplySnapshot, any Error>.makeStream()
  func send(_ delivery: PendingDelivery) async throws -> ConversationMessage {
    throw ConversationFailure.unavailable
  }
  func history(after: Int?) async throws -> HistoryPage {
    HistoryPage(messages: [], nextAfter: nil)
  }
  func currentTurn() async throws -> CurrentTurn? {
    CurrentTurn(
      input: input,
      reply: ReplySnapshot(
        responseId: response,
        inputDeliveryId: input.deliveryId, sequence: 0, state: .waiting, text: "",
        responseLanguage: "en"))
  }
  func observeReply(for inputDeliveryId: UUID) async throws -> ReplyObservation {
    let continuation = stream.continuation
    return ReplyObservation(events: stream.stream, cancel: { continuation.finish() })
  }
  func emit(_ snapshot: ReplySnapshot) { stream.continuation.yield(snapshot) }
  func snapshot(text: String, spans: [LanguageSpan]) -> ReplySnapshot {
    ReplySnapshot(
      responseId: response, inputDeliveryId: input.deliveryId, sequence: 1,
      state: .streaming, text: text, languageSpans: spans, responseLanguage: "en")
  }
  func interruptedReceipt(spans: [LanguageSpan]) -> ConversationMessage {
    ConversationMessage(
      deliveryId: response, recordId: 2, position: 2, text: "Bonjour Hello",
      role: .assistant, responseId: response, inputDeliveryId: input.deliveryId,
      outcome: .interrupted,
      languageSpans: spans)
  }
}
