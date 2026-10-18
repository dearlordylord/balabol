import XCTest

@testable import Voice

final class VoiceGenerationCueTests: XCTestCase {
  func testFailureCueAndTerminalOutputCleanupCommuteWhileSpeechCancelsBothOrders() throws {
    let input = UUID(), response = UUID(), epoch = UUID()
    let data = try JSONSerialization.data(withJSONObject: [
      "responseId": response.uuidString, "inputDeliveryId": input.uuidString,
      "outputEpoch": epoch.uuidString, "status": "Failed", "manifest": NSNull(),
      "error": ["code": "ProviderFailed", "message": "Unavailable"],
    ])
    let failed = try JSONDecoder().decode(VoiceOutput.self, from: data)
    let initial = try VoiceLifecycleITFMapping().initial()
    let cue = VoiceInput(event: .generationCue(input: input, response: response, cue: .failed), proposedStartRequestId: UUID())
    let before = transitionVoice(initial, cue)
    XCTAssertTrue(before.commands.contains { if case .generationCue(.failed) = $0 { true } else { false } })
    let output = composeVoiceOutput(VoiceTransition(state: before.state, commands: []), .observed(sequence: 1, failed))
    XCTAssertTrue(output.commands.contains {
      if case .run(_, .stopMedia(_, true, _, _, true), _) = $0 { true } else { false }
    })
    let after = transitionVoice(output.state, cue)
    XCTAssertTrue(after.commands.contains { if case .generationCue(.failed) = $0 { true } else { false } })
    let speech = transitionVoice(after.state, .init(event: .speechIntent, proposedStartRequestId: UUID()))
    XCTAssertTrue(speech.commands.contains { if case .cancelGenerationCue = $0 { true } else { false } })
    XCTAssertFalse(transitionVoice(speech.state, cue).commands.contains { if case .generationCue = $0 { true } else { false } })
    let muted = initial.replacing(capture: initial.captureModel.replacing(intent: .listening(muted: true), capture: .muted))
    let mutedCue = transitionVoice(muted, cue)
    XCTAssertEqual(mutedCue.state.intent, .listening(muted: true))
    XCTAssertTrue(mutedCue.commands.contains { if case .generationCue(.failed) = $0 { true } else { false } })
  }

  func testFailureDuringActualAudioWaitsForExactLocalStopWithoutServerStatusAndSpeechCancelsPendingCue() throws {
    let input = UUID(), response = UUID(), epoch = UUID(), session = UUID()
    let data = try JSONSerialization.data(withJSONObject: [
      "responseId": response.uuidString, "inputDeliveryId": input.uuidString,
      "outputEpoch": epoch.uuidString, "status": "Playing", "error": NSNull(),
      "manifest": ["sessionId": session.uuidString, "responseId": response.uuidString,
        "inputDeliveryId": input.uuidString, "outputEpoch": epoch.uuidString,
        "publisherIdentity": UUID().uuidString, "trackSid": "TR_test",
        "sourceAudio": ["encoding": "pcm-s16le", "sampleRateHz": 24000, "channels": 1]],
    ])
    let playing = try JSONDecoder().decode(VoiceOutput.self, from: data)
    let initial = try VoiceLifecycleITFMapping().initial()
    let state = initial.replacing(output: initial.output.replacing(current: .some(playing), receivedAudio: true, prepared: .some(playing.identity)))
    let cue = VoiceInput(event: .generationCue(input: input, response: response, cue: .failed), proposedStartRequestId: UUID())
    let failure = transitionVoice(state, cue)
    XCTAssertEqual(failure.state.output.current?.status, .failed)
    XCTAssertEqual(failure.state.execution.pendingFailureCue, playing.identity)
    XCTAssertFalse(failure.commands.contains { if case .generationCue = $0 { true } else { false } })
    let stop = try XCTUnwrap(failure.state.execution.localStop)
    let complete = VoiceInput(event: .completed(stop, .stopped), proposedStartRequestId: UUID())
    let finished = transitionVoice(failure.state, complete)
    XCTAssertTrue(finished.commands.contains { if case .generationCue(.failed) = $0 { true } else { false } })
    XCTAssertNil(finished.state.execution.pendingFailureCue)
    XCTAssertFalse(transitionVoice(finished.state, complete).commands.contains { if case .generationCue = $0 { true } else { false } })
    let unrelated = transitionVoice(failure.state, .init(event: .completed(VoiceRequest(generation: 0, id: 900), .stopped), proposedStartRequestId: UUID()))
    XCTAssertFalse(unrelated.commands.contains { if case .generationCue = $0 { true } else { false } })
    let serverFirst = composeVoiceOutput(VoiceTransition(state: state, commands: []), .observed(sequence: 1, VoiceOutput(failing: playing)))
    let pending = transitionVoice(serverFirst.state, cue)
    XCTAssertFalse(pending.commands.contains { if case .generationCue = $0 { true } else { false } })
    let serverStop = try XCTUnwrap(pending.state.execution.localStop)
    let serverFinished = transitionVoice(pending.state, .init(event: .completed(serverStop, .stopped), proposedStartRequestId: UUID()))
    XCTAssertTrue(serverFinished.commands.contains { if case .generationCue(.failed) = $0 { true } else { false } })
    let ended = transitionVoice(failure.state, .init(event: .end, proposedStartRequestId: UUID()))
    XCTAssertNil(ended.state.execution.pendingFailureCue)
    XCTAssertFalse(transitionVoice(ended.state, complete).commands.contains { if case .generationCue = $0 { true } else { false } })
    let cancelled = transitionVoice(failure.state, .init(event: .cancelGenerationCue, proposedStartRequestId: UUID()))
    XCTAssertNil(cancelled.state.execution.pendingFailureCue)
    XCTAssertFalse(transitionVoice(cancelled.state, complete).commands.contains { if case .generationCue = $0 { true } else { false } })
    let cut = transitionVoice(failure.state, .init(event: .speechIntent, proposedStartRequestId: UUID()))
    XCTAssertNil(cut.state.execution.pendingFailureCue)
    XCTAssertFalse(transitionVoice(cut.state, complete).commands.contains { if case .generationCue = $0 { true } else { false } })
  }

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
