import XCTest

@testable import Conversation

final class ConversationTransitionContractTests: XCTestCase {
  func testPureEntryPreservesInputAndProducesDeterministicStateAndCommands() {
    let original = ConversationState()
    let first = transitionConversation(original, .start)
    let repeated = transitionConversation(original, .start)
    XCTAssertEqual(original, ConversationState())
    XCTAssertEqual(first.state, repeated.state)
    XCTAssertEqual(first.commands, repeated.commands)
    XCTAssertNotEqual(first.state, original)
    guard case .loadDraft(let request) = first.commands.first else {
      return XCTFail("Start must request draft restoration")
    }
    let restored = transitionConversation(
      first.state, .draftLoaded(request, .success(.editable(text: "Saved"))))
    XCTAssertEqual(restored.state.draftText, "Saved")
    XCTAssertEqual(original.draft, .unloaded)
    XCTAssertEqual(first.state.draft, .loading(request, previous: nil))
  }

  func testConflictingPlatformReceiptIsExplicitWithoutReplacingDurableHistory() {
    var state = ConversationState()
    let input = UUID()
    let response = UUID()
    let receipt = ConversationMessage(
      deliveryId: response, recordId: 1, position: 1,
      text: "Saved", role: .assistant, responseId: response, inputDeliveryId: input)
    state.messages = [receipt]
    let request = ConversationState.Request(generation: 0, id: 10)
    state.platformCancellations[input] = .init(request: request, responseId: response)
    let conflicting = ConversationMessage(
      deliveryId: response, recordId: 1, position: 1,
      text: "Conflict", role: .assistant, responseId: response, inputDeliveryId: input)
    let snapshot = ReplySnapshot(
      responseId: response, inputDeliveryId: input, sequence: 2,
      state: .completed, text: conflicting.text, receipt: conflicting)
    let result = transitionConversation(state, .platformInterrupted(request, input, snapshot))
    XCTAssertEqual(result.state.messages, [receipt])
    XCTAssertEqual(result.state.interruptedReceiptFailure, .invalidResponse)
    XCTAssertTrue(result.state.platformCancellations.isEmpty)
    XCTAssertTrue(result.commands.isEmpty)
    XCTAssertEqual(state.platformCancellations.count, 1)
  }
}

@MainActor
final class ConversationCommandBatchTests: XCTestCase {
  func testInputIntentSeesCommittedStateAndReentrantReceiptWaitsForCommandBatch() async throws {
    let transport = ScriptedTransport()
    weak var callbackModel: ConversationViewModel?
    var observedIntent = false
    let voice = ConversationMessage(
      deliveryId: UUID(), recordId: 8, position: 1, text: "Voice input")
    let model = ConversationViewModel(
      transport: transport, draftStore: MemoryDraftStore(),
      inputIntent: { identity in
        guard let model = callbackModel else { return XCTFail("Missing ViewModel") }
        observedIntent = true
        XCTAssertEqual(model.pendingDelivery?.deliveryId, identity)
        XCTAssertTrue(model.isSending)
        model.acceptVoiceReceipt(voice)
        XCTAssertFalse(
          model.messages.contains(voice), "A synchronous callback cannot split a command batch")
      })
    callbackModel = model
    await model.start()
    model.editDraft("Text input")
    await model.send()
    XCTAssertTrue(observedIntent)
    XCTAssertTrue(model.messages.contains(voice))
    XCTAssertEqual(model.messages.map(\.text), ["Text input", "Voice input"])
    XCTAssertNil(model.pendingDelivery)
    await model.shutdown()
  }
}
