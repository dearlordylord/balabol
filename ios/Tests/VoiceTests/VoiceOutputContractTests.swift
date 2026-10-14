import XCTest

@testable import Voice

final class VoiceOutputContractTests: XCTestCase {
  func testOutputBoundaryRejectsWrongFormatIdentityAndMissingRequiredNulls() throws {
    let session = UUID()
    let response = UUID()
    let input = UUID()
    let epoch = UUID()
    var manifest: [String: Any] = [
      "sessionId": session.uuidString, "responseId": response.uuidString,
      "inputDeliveryId": input.uuidString, "outputEpoch": epoch.uuidString,
      "publisherIdentity": UUID().uuidString, "trackSid": "TR_fixture",
      "sourceAudio": ["encoding": "pcm-s16le", "sampleRateHz": 24000, "channels": 1],
    ]
    var output: [String: Any] = [
      "responseId": response.uuidString, "inputDeliveryId": input.uuidString,
      "outputEpoch": epoch.uuidString, "status": "AwaitingReady", "manifest": manifest,
      "error": NSNull(),
    ]
    let valid = try decode(output)
    XCTAssertTrue(valid.isValid(sessionId: session))
    XCTAssertFalse(valid.isValid(sessionId: UUID()))
    output.removeValue(forKey: "error")
    XCTAssertThrowsError(try decode(output))
    output["error"] = NSNull()
    manifest["outputEpoch"] = UUID().uuidString
    output["manifest"] = manifest
    XCTAssertThrowsError(try decode(output))
    manifest["outputEpoch"] = epoch.uuidString
    manifest["sourceAudio"] = ["encoding": "pcm-s16le", "sampleRateHz": 16000, "channels": 1]
    output["manifest"] = manifest
    XCTAssertThrowsError(try decode(output))
  }
  private func decode(_ value: [String: Any]) throws -> VoiceOutput {
    try JSONDecoder().decode(VoiceOutput.self, from: JSONSerialization.data(withJSONObject: value))
  }
}
