import XCTest

@testable import Voice

final class VoiceGenerationCueTests: XCTestCase {
  func testLiveOwnerAllowsCueButCutAudioAndRetirementDenyIt() throws {
    let mapping = VoiceLifecycleITFMapping()
    let state = try mapping.initial()
    let input = UUID()
    let response = UUID()
    let event = VoiceInput(
      event: .generationCue(input: input, response: response, cue: .generationStarted),
      proposedStartRequestId: UUID())
    let live = transitionVoice(state, event)
    XCTAssertTrue(
      live.commands.contains {
        if case .generationCue(.generationStarted) = $0 { true } else { false }
      })
    let data = try JSONSerialization.data(withJSONObject: [
      "responseId": response.uuidString, "inputDeliveryId": input.uuidString,
      "outputEpoch": UUID().uuidString, "status": "Preparing", "manifest": NSNull(),
      "error": NSNull(),
    ])
    let current = try JSONDecoder().decode(VoiceOutput.self, from: data)
    let audio = state.replacing(
      output: state.output.replacing(current: .some(current), receivedAudio: true))
    XCTAssertFalse(
      transitionVoice(audio, event).commands.contains {
        if case .generationCue = $0 { true } else { false }
      })
    let cut = transitionVoice(state, .init(event: .speechIntent, proposedStartRequestId: UUID()))
      .state
    XCTAssertFalse(
      transitionVoice(cut, event).commands.contains {
        if case .generationCue = $0 { true } else { false }
      })
    let retryState = audio.replacing(output: audio.output.replacing(allowedInput: .some(input), gated: true))
    let retryEvent = VoiceInput(event: .generationCue(input: input, response: UUID(), cue: .generationStarted), proposedStartRequestId: UUID())
    XCTAssertTrue(transitionVoice(retryState, retryEvent).commands.contains { if case .generationCue = $0 { true } else { false } })
    let replacementInput = UUID()
    let replacement = audio.replacing(
      output: audio.output.replacing(allowedInput: .some(replacementInput), gated: true))
    let replacementEvent = VoiceInput(
      event: .generationCue(input: replacementInput, response: UUID(), cue: .generationStarted),
      proposedStartRequestId: UUID())
    XCTAssertTrue(
      transitionVoice(replacement, replacementEvent).commands.contains {
        if case .generationCue = $0 { true } else { false }
      })
    let retired = transitionVoice(state, .init(event: .shutdown, proposedStartRequestId: UUID()))
      .state
    XCTAssertFalse(
      transitionVoice(retired, event).commands.contains {
        if case .generationCue = $0 { true } else { false }
      })
  }
}
