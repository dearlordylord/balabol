import Conversation
import Foundation
import XCTest

@testable import Voice

@MainActor final class VoiceLanguagesTests: XCTestCase {
  func testConfiguredLanguagesAreNotFilteredAndJapaneseAppearsOnlyWhenValidated() throws {
    let baseline = try decode(allowed: ["ru", "fr", "en"], supported: ["ru", "fr", "en", "ja"])
    XCTAssertTrue(baseline.isValid)
    XCTAssertEqual(
      baseline.displayNames(locale: Locale(identifier: "en")), "Russian · French · English")
    let japanese = try decode(allowed: ["ja"], supported: ["ja"])
    XCTAssertTrue(japanese.isValid)
    XCTAssertEqual(japanese.displayNames(locale: Locale(identifier: "en")), "Japanese")
    XCTAssertFalse(try decode(allowed: ["ru", "ja"], supported: ["ru"]).isValid)
  }
  func testMalformedDuplicateAndUnboundedCapabilitiesAreRejected() throws {
    XCTAssertFalse(try decode(allowed: [], supported: ["en"]).isValid)
    XCTAssertFalse(try decode(allowed: ["en", "en"], supported: ["en"]).isValid)
    XCTAssertFalse(try decode(allowed: ["EN"], supported: ["EN"]).isValid)
    XCTAssertFalse(try decode(allowed: ["bad_tag"], supported: ["bad_tag"]).isValid)
    XCTAssertFalse(
      try decode(allowed: ["en"], supported: Array(repeating: "en", count: 33)).isValid)
  }
  func testFinalAnnotationsValidateScalarOffsetsAndExplicitNullIsMalformed() throws {
    let delivery = UUID().uuidString
    var fields: [String: Any] = [
      "sequence": 1, "sessionId": UUID().uuidString, "kind": "Final",
      "backendIncarnationId": UUID().uuidString, "utteranceId": delivery, "deliveryId": delivery,
      "text": "😀", "languageSpans": [["language": "ja", "start": 0, "end": 2]],
    ]
    let final = try JSONDecoder().decode(
      VoiceWireEvent.self,
      from: JSONSerialization.data(withJSONObject: fields))
    XCTAssertTrue(final.isValid)
    XCTAssertEqual(final.languageSpans, [LanguageSpan(language: "ja", start: 0, end: 2)])
    fields["languageSpans"] = [["language": "ja", "start": 0, "end": 1]]
    let split = try JSONDecoder().decode(
      VoiceWireEvent.self,
      from: JSONSerialization.data(withJSONObject: fields))
    XCTAssertFalse(split.isValid)
    fields["languageSpans"] = NSNull()
    XCTAssertThrowsError(
      try JSONDecoder().decode(
        VoiceWireEvent.self,
        from: JSONSerialization.data(withJSONObject: fields)))
    fields.removeValue(forKey: "languageSpans")
    let legacy = try JSONDecoder().decode(
      VoiceWireEvent.self,
      from: JSONSerialization.data(withJSONObject: fields))
    XCTAssertTrue(legacy.isValid)
    XCTAssertNil(legacy.languageSpans)
  }

  private func decode(allowed: [String], supported: [String]) throws -> VoiceLanguages {
    try JSONDecoder().decode(
      VoiceLanguages.self,
      from: JSONSerialization.data(withJSONObject: [
        "allowedLanguages": allowed, "supportedLanguages": supported,
      ]))
  }
}
