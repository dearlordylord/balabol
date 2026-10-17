import XCTest

@testable import Conversation

@MainActor
final class GenerationCueTests: XCTestCase {
  func testLiveGenerationAndTextReadyEachCueOnceWithoutWaitingForText() async throws {
    let transport = ControlledReplyTransport()
    let started = expectation(description: "Generation sound before text")
    let ready = expectation(description: "Text ready sound")
    var cues: [ConversationGenerationCue] = []
    let model = ConversationViewModel(
      transport: transport, draftStore: MemoryDraftStore(),
      generationCue: { _, _, cue in
        cues.append(cue)
        if cue == .generationStarted { started.fulfill() } else { ready.fulfill() }
      })
    await model.start()
    model.editDraft("Hello")
    await model.send()
    await transport.waitForObservation()
    let input = try XCTUnwrap(model.messages.first?.deliveryId)
    let response = UUID()
    let generating = ReplySnapshot(
      responseId: response, inputDeliveryId: input, sequence: 1, state: .waiting, text: "",
      generationStarted: true)
    await transport.emit(generating)
    await fulfillment(of: [started], timeout: 1)
    XCTAssertEqual(model.replyText, "")
    await transport.emit(generating)
    let generated = ReplySnapshot(
      responseId: response, inputDeliveryId: input, sequence: 2, state: .delivering, text: "Ready",
      generationStarted: true, generationCompleted: true)
    await transport.emit(generated)
    await fulfillment(of: [ready], timeout: 1)
    await transport.emit(generated)
    await model.shutdown()
    XCTAssertEqual(cues, [.generationStarted, .textReady])
  }

  func testRestoredAndStaleEventsDoNotCueAndCoalescedReadyDoesNotBurst() {
    let input = UUID()
    let response = UUID()
    let request = ConversationState.Request(generation: 0, id: 1)
    let ready = ReplySnapshot(
      responseId: response, inputDeliveryId: input, sequence: 2, state: .delivering, text: "Ready",
      generationStarted: true, generationCompleted: true)
    var state = ConversationState()
    state.reply = .observing(request, inputDeliveryId: input, latest: nil)
    XCTAssertEqual(state.transition(.replyReceived(request, ready)), [])
    state.cueInput = input
    XCTAssertEqual(state.transition(.replyReceived(request, ready)), [.generationCue(input, response, .textReady)])
    XCTAssertEqual(state.transition(.replyReceived(request, ready)), [])
    let stale = ConversationState.Request(generation: 0, id: 2)
    let originalCueInput = state.cueInput
    XCTAssertEqual(state.transition(.observationRecovered(stale, .success(ready))), [])
    XCTAssertEqual(state.cueInput, originalCueInput)
    XCTAssertEqual(state.transition(.replyReceived(stale, ready)), [])
  }

  func testExplicitRetryArmsNewResponseForSameInputWithoutReplayingOldResponse() {
    let input = ConversationMessage(deliveryId: UUID(), recordId: 1, position: 0, text: "Retry me")
    let oldResponse = UUID()
    var state = ConversationState()
    state.messages = [input]
    state.draft = .available(.editable(text: ""), .clean)
    state.reply = .providerFailed(inputDeliveryId: input.deliveryId, text: "",
      ReplyFailure(code: .providerFailed, message: "Failed"))
    state.cueInput = input.deliveryId
    state.cueResponse = oldResponse
    state.cueStage = 1
    let commands = state.transition(.retryReply)
    guard case .observing(let request, _, _) = state.reply else { return XCTFail("Expected retry") }
    XCTAssertTrue(commands.contains(.inputIntent(input.deliveryId)))
    let next = ReplySnapshot(responseId: UUID(), inputDeliveryId: input.deliveryId,
      sequence: 1, state: .waiting, text: "", generationStarted: true)
    _ = state.transition(.retryLoaded(request, .success(next)))
    XCTAssertEqual(state.transition(.replyReceived(request, next)),
      [.generationCue(input.deliveryId, next.responseId, .generationStarted)])
    XCTAssertEqual(state.transition(.replyReceived(request, next)), [])
    let obsolete = ReplySnapshot(responseId: oldResponse, inputDeliveryId: input.deliveryId,
      sequence: 2, state: .waiting, text: "", generationStarted: true)
    XCTAssertFalse(state.transition(.replyReceived(request, obsolete)).contains {
      if case .generationCue = $0 { true } else { false }
    })
  }

  func testInvalidGenerationEvidenceIsRejectedAtCodableBoundary() throws {
    let invalid = ReplySnapshot(
      responseId: UUID(), inputDeliveryId: UUID(), sequence: 1, state: .waiting, text: "",
      generationCompleted: true)
    XCTAssertFalse(invalid.isValid)
    XCTAssertThrowsError(try JSONDecoder().decode(ReplySnapshot.self, from: JSONEncoder().encode(invalid)))
  }
}
