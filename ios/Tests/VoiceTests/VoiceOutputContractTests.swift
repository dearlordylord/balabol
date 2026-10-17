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
  func testEveryTerminalStatusIsRetainedAcrossSuppressionWithoutReopeningPlayback() throws {
    for status in ["Interrupted", "Delivered", "Failed"] {
      for allowsOtherInput in [false, true] {
        let playing = try output(status: "Playing")
        let initial = transitionVoiceOutput(VoiceOutputState(), .observed(sequence: 1, playing))
          .state
        let next = allowsOtherInput ? UUID() : nil
        let cut = transitionVoiceOutput(initial, .cut(nextInput: next, pendingInputs: [])).state
        let terminal = try output(status: status, matching: playing)
        let result = transitionVoiceOutput(cut, .observed(sequence: 2, terminal))
        XCTAssertEqual(result.state.current, terminal)
        XCTAssertEqual(result.state.locallyInterrupted, status != "Failed")
        XCTAssertEqual(result.state.unavailable, status == "Failed")
        XCTAssertNil(result.state.prepared)
        XCTAssertFalse(result.commands.contains { if case .prepare = $0 { true } else { false } })
        let late = transitionVoiceOutput(result.state, .observed(sequence: 3, playing))
        XCTAssertEqual(late.state.current, terminal)
        XCTAssertNil(late.state.prepared)
        let duplicate = transitionVoiceOutput(result.state, .observed(sequence: 2, terminal))
        XCTAssertEqual(duplicate.state, result.state)
        XCTAssertTrue(duplicate.commands.isEmpty)
      }
    }
  }

  func testOtherIdentityCannotBorrowPermissionAndFreshReplacementCanPrepare() throws {
    let playing = try output(status: "Playing")
    let selected = transitionVoiceOutput(VoiceOutputState(), .observed(sequence: 1, playing)).state
    let newInput = UUID()
    let cut = transitionVoiceOutput(selected, .cut(nextInput: newInput, pendingInputs: [])).state
    let unrelated = try output(status: "Delivered")
    let rejected = transitionVoiceOutput(cut, .observed(sequence: 2, unrelated))
    XCTAssertEqual(rejected.state.current, playing)
    XCTAssertNil(rejected.state.prepared)
    XCTAssertTrue(rejected.commands.isEmpty)
    let replacement = try output(status: "Playing", input: newInput)
    let admitted = transitionVoiceOutput(rejected.state, .observed(sequence: 3, replacement))
    XCTAssertEqual(admitted.state.current, replacement)
    XCTAssertFalse(admitted.state.locallyInterrupted)
    XCTAssertEqual(admitted.state.prepared, replacement.identity)
    XCTAssertTrue(admitted.commands.contains { if case .prepare = $0 { true } else { false } })
    let oldTerminal = try output(status: "Interrupted", matching: playing)
    let old = transitionVoiceOutput(admitted.state, .observed(sequence: 4, oldTerminal))
    XCTAssertEqual(old.state.current, replacement)
    XCTAssertEqual(old.state.prepared, replacement.identity)
    XCTAssertTrue(old.commands.isEmpty)
  }

  private func output(status: String, matching: VoiceOutput? = nil, input: UUID? = nil) throws
    -> VoiceOutput
  {
    let input = matching?.inputDeliveryId ?? input ?? UUID()
    let response = matching?.responseId ?? UUID()
    let epoch = matching?.outputEpoch ?? UUID()
    let manifest: [String: Any] = [
      "sessionId": (matching?.manifest?.sessionId ?? UUID()).uuidString,
      "responseId": response.uuidString,
      "inputDeliveryId": input.uuidString, "outputEpoch": epoch.uuidString,
      "publisherIdentity": UUID().uuidString, "trackSid": "TR_fixture",
      "sourceAudio": ["encoding": "pcm-s16le", "sampleRateHz": 24000, "channels": 1],
    ]
    return try decode([
      "responseId": response.uuidString, "inputDeliveryId": input.uuidString,
      "outputEpoch": epoch.uuidString, "status": status,
      "manifest": status == "Interrupted" || status == "Failed" ? NSNull() : manifest,
      "error": status == "Failed"
        ? ["code": "AudioUnavailable", "message": "Output failed"] : NSNull(),
    ])
  }
  private func decode(_ value: [String: Any]) throws -> VoiceOutput {
    try JSONDecoder().decode(VoiceOutput.self, from: JSONSerialization.data(withJSONObject: value))
  }
}
