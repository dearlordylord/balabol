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
  func testTerminalStatusForCutOutputIsRetainedWithoutReopeningPlayback() throws {
    let input = UUID()
    let response = UUID()
    let epoch = UUID()
    let session = UUID()
    let manifest: [String: Any] = [
      "sessionId": session.uuidString, "responseId": response.uuidString,
      "inputDeliveryId": input.uuidString, "outputEpoch": epoch.uuidString,
      "publisherIdentity": UUID().uuidString, "trackSid": "TR_fixture",
      "sourceAudio": ["encoding": "pcm-s16le", "sampleRateHz": 24000, "channels": 1],
    ]
    let playing = try decode([
      "responseId": response.uuidString, "inputDeliveryId": input.uuidString,
      "outputEpoch": epoch.uuidString, "status": "Playing", "manifest": manifest,
      "error": NSNull(),
    ])
    let initial = transitionVoiceOutput(VoiceOutputState(), .observed(sequence: 1, playing)).state
    let cut = transitionVoiceOutput(initial, .cut(nextInput: nil, pendingInputs: [])).state
    let terminal = try decode([
      "responseId": response.uuidString, "inputDeliveryId": input.uuidString,
      "outputEpoch": epoch.uuidString, "status": "Interrupted", "manifest": NSNull(),
      "error": NSNull(),
    ])
    let result = transitionVoiceOutput(cut, .observed(sequence: 2, terminal))
    XCTAssertEqual(result.state.current?.status, .interrupted)
    XCTAssertTrue(result.state.locallyInterrupted)
    XCTAssertNil(result.state.prepared)
    XCTAssertFalse(result.commands.contains { if case .prepare = $0 { true } else { false } })
    let late = transitionVoiceOutput(result.state, .observed(sequence: 3, playing))
    XCTAssertEqual(late.state.current?.status, .interrupted)
    XCTAssertNil(late.state.prepared)
  }
  private func decode(_ value: [String: Any]) throws -> VoiceOutput {
    try JSONDecoder().decode(VoiceOutput.self, from: JSONSerialization.data(withJSONObject: value))
  }
}
