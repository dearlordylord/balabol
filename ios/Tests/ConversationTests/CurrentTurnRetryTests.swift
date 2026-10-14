import XCTest

@testable import Conversation

@MainActor
final class CurrentTurnRetryTests: XCTestCase {
  private func turn(position: Int = 24, phase: ReplySnapshot.Phase = .failed) -> CurrentTurn {
    let input = ConversationMessage(
      deliveryId: UUID(), recordId: position, position: position, text: "Saved input")
    let reply = ReplySnapshot(
      responseId: UUID(), inputDeliveryId: input.deliveryId,
      sequence: 0, state: phase, text: "",
      error: phase == .failed
        ? ReplyFailure(code: .memoryFailed, message: "Prior summary failed") : nil)
    return CurrentTurn(input: input, reply: reply)
  }
  func testStartupRestoresLatestFailureWithoutPagingAndRetryPreservesDraft() async throws {
    let saved = turn()
    let transport = CurrentRetryTransport(turn: saved)
    let store = MemoryDraftStore()
    try await store.save(.editable(text: "Next thought"))
    let model = ConversationViewModel(transport: transport, draftStore: store)
    await model.start()
    XCTAssertEqual(model.messages, [saved.input])
    XCTAssertNil(model.state.historyCursor)
    XCTAssertTrue(model.canRetryReply)
    await model.retryReply()
    XCTAssertEqual(model.draft, "Next thought")
    XCTAssertEqual(model.messages, [saved.input])
    XCTAssertNil(model.pendingDelivery)
    XCTAssertTrue(model.isObservingReply)
    let inputs = await transport.retryInputs
    XCTAssertEqual(inputs, [saved.input.deliveryId])
    await model.shutdown()
  }
  func testLateRetryAndCurrentCannotReplaceNewSend() throws {
    var state = ConversationState()
    state.draft = .available(.editable(text: "New input"), .clean)
    let saved = turn()
    let commands = state.transition(.refreshCurrent)
    guard case .current(let current) = commands.first else {
      return XCTFail("Expected current read")
    }
    _ = state.transition(.currentLoaded(current, .success(saved)))
    let retries = state.transition(.retryReply)
    guard case .observing(let retry, _, _) = state.reply else { return XCTFail("Expected retry") }
    XCTAssertEqual(retries.count, 3)
    let identity = UUID()
    _ = state.transition(.send(identity))
    let before = state.reply
    _ = state.transition(.retryLoaded(retry, .success(turn(phase: .waiting).reply)))
    _ = state.transition(.currentLoaded(current, .success(saved)))
    XCTAssertEqual(state.reply, before)
    XCTAssertEqual(state.pendingDelivery?.deliveryId, identity)
  }
  func testOldPendingAcknowledgementClearsCheckpointWithoutFollowingOldReply() {
    var state = ConversationState()
    let old = turn(position: 0)
    let newer = turn(position: 8)
    let pending = PendingDelivery(deliveryId: old.input.deliveryId, text: old.input.text)
    state.messages = [newer.input]
    state.draft = .available(.awaitingReceipt(pending), .clean)
    let commands = state.transition(.refreshCurrent)
    guard case .current(let request) = commands.first else {
      return XCTFail("Expected current read")
    }
    _ = state.transition(.currentLoaded(request, .success(old)))
    XCTAssertNil(state.pendingDelivery)
    XCTAssertEqual(state.reply, .idle)
    XCTAssertNil(state.historyCursor)
  }
  func testUncertainDeliveryBlocksReplyRetry() {
    var state = ConversationState()
    let saved = turn()
    state.messages = [saved.input]
    state.reply = .providerFailed(
      inputDeliveryId: saved.input.deliveryId, text: "", saved.reply.error!)
    state.draft = .available(
      .awaitingReceipt(PendingDelivery(deliveryId: UUID(), text: "Unconfirmed")), .clean)
    XCTAssertFalse(state.canRetryReply)
    XCTAssertTrue(state.transition(.retryReply).isEmpty)
  }
  func testCurrentFailureDoesNotDisplaceUncertainPendingDelivery() {
    var state = ConversationState()
    let pending = PendingDelivery(deliveryId: UUID(), text: "Unconfirmed input")
    state.draft = .available(.awaitingReceipt(pending), .clean)
    state.delivery = .uncertain(pending, .unavailable)
    let commands = state.transition(.refreshCurrent)
    guard case .current(let request) = commands.first else {
      return XCTFail("Expected current read")
    }
    let saved = turn()
    let next = state.transition(.currentLoaded(request, .success(saved)))
    XCTAssertTrue(next.isEmpty)
    XCTAssertEqual(state.pendingDelivery, pending)
    XCTAssertEqual(state.reply, .idle)
    XCTAssertFalse(state.canRetryReply)
    XCTAssertEqual(state.messages, [saved.input])
  }
  func testCurrentTurnRejectsCrossInputSnapshot() throws {
    let saved = turn()
    let mismatched = CurrentTurn(input: saved.input, reply: turn().reply)
    XCTAssertThrowsError(
      try JSONDecoder().decode(CurrentTurn.self, from: JSONEncoder().encode(mismatched)))
  }
}

private actor CurrentRetryTransport: ConversationTransport {
  let turn: CurrentTurn
  private(set) var retryInputs: [UUID] = []
  init(turn: CurrentTurn) { self.turn = turn }
  func currentTurn() async throws -> CurrentTurn? { turn }
  func retryReply(for inputDeliveryId: UUID) async throws -> ReplySnapshot {
    retryInputs.append(inputDeliveryId)
    return ReplySnapshot(
      responseId: UUID(), inputDeliveryId: inputDeliveryId, sequence: 0, state: .waiting, text: "")
  }
  func send(_ delivery: PendingDelivery) async throws -> ConversationMessage {
    throw ConversationFailure.unavailable
  }
  func history(after: Int?) async throws -> HistoryPage { throw ConversationFailure.unavailable }
  func observeReply(for inputDeliveryId: UUID) async throws -> ReplyObservation {
    let stream = AsyncThrowingStream<ReplySnapshot, any Error>.makeStream()
    return ReplyObservation(events: stream.stream, cancel: { stream.continuation.finish() })
  }
}

@MainActor
final class LiveCurrentTurnRetryTests: XCTestCase {
  func testFailedMemoryRestoresAndRetryUsesAcceptedInputWithoutResending() async throws {
    guard let endpoint = ProcessInfo.processInfo.environment["BALABOL_MEMORY_TEST_SERVER"],
      let url = URL(string: endpoint)
    else {
      throw XCTSkip("Set BALABOL_MEMORY_TEST_SERVER to the isolated failed-summary fixture.")
    }
    let session = URLSession(configuration: .ephemeral)
    defer { session.invalidateAndCancel() }
    let transport = try HTTPConversationTransport(baseURL: url, session: session)
    let beforeValue = try await transport.currentTurn()
    let before = try XCTUnwrap(beforeValue)
    XCTAssertEqual(before.reply.state, .failed)
    let store = MemoryDraftStore()
    try await store.save(.editable(text: "Keep my next thought"))
    let model = ConversationViewModel(transport: transport, draftStore: store)
    await model.start()
    XCTAssertTrue(model.canRetryReply)
    XCTAssertEqual(model.messages.first, before.input)
    XCTAssertNil(model.state.historyCursor)
    await model.retryReply()
    for _ in 0..<1000 {
      if case .completed = model.state.reply { break }
      try await Task.sleep(for: .milliseconds(10))
    }
    XCTAssertEqual(model.draft, "Keep my next thought")
    XCTAssertNil(model.pendingDelivery)
    XCTAssertNil(model.replyProviderFailure)
    XCTAssertNil(model.replyObservationFailure)
    let afterValue = try await transport.currentTurn()
    let after = try XCTUnwrap(afterValue)
    XCTAssertEqual(after.input, before.input)
    XCTAssertNotEqual(after.reply.responseId, before.reply.responseId)
    XCTAssertEqual(after.reply.state, .completed)
    XCTAssertEqual(model.messages.filter { $0.role == .user }, [before.input])
    XCTAssertEqual(model.messages.last, after.reply.receipt)
    let terminal = try await transport.retryReply(for: before.input.deliveryId)
    XCTAssertEqual(terminal, after.reply)
    await model.shutdown()
    let restored = ConversationViewModel(transport: transport, draftStore: MemoryDraftStore())
    await restored.start()
    XCTAssertFalse(restored.canRetryReply)
    XCTAssertEqual(restored.messages.last, after.reply.receipt)
    XCTAssertNil(restored.state.historyCursor)
    await restored.shutdown()
  }
}
