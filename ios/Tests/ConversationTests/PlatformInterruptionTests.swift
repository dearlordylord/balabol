import Foundation
import Testing

@testable import Conversation

struct PlatformInterruptionTests {
  @Test func exactDisplayedResponseIsCapturedBeforeAnyNetworkWork() {
    var state = ConversationState()
    let input = UUID()
    let response = UUID()
    let request = ConversationState.Request(generation: 0, id: 10)
    state.reply = .observing(
      request, inputDeliveryId: input,
      latest: ReplySnapshot(
        responseId: response, inputDeliveryId: input, sequence: 1, state: .streaming,
        text: "Partial"))
    let commands = state.transition(.platformInterrupt([]))
    #expect(commands.count == 1)
    guard case .interruptPlatformTarget(_, let capturedInput, let capturedResponse) = commands.first
    else {
      Issue.record("Expected exact target cancellation")
      return
    }
    #expect(capturedInput == input && capturedResponse == response)
    #expect(state.platformCancellations.count == 1)
  }
  @Test func retryInvalidatesUnknownResponseFenceAndLateSnapshotCannotCancelRetry() {
    var state = ConversationState()
    let input = UUID()
    _ = state.transition(.platformInterrupt([input]))
    guard let old = state.platformCancellations[input] else {
      Issue.record("Missing fence")
      return
    }
    state.messages = [
      ConversationMessage(deliveryId: input, recordId: 0, position: 0, text: "Accepted")
    ]
    state.draft = .available(.editable(text: "Independent"), .clean)
    state.reply = .providerFailed(
      inputDeliveryId: input, text: "", ReplyFailure(code: .providerFailed, message: "Failed"))
    _ = state.transition(.retryReply)
    let newer = ReplySnapshot(
      responseId: UUID(), inputDeliveryId: input, sequence: 0, state: .waiting, text: "")
    #expect(state.transition(.platformTargetLoaded(old.request, input, newer)).isEmpty)
    #expect(state.platformCancellations.isEmpty)
  }
  @Test func queuedHandedInputsAreBoundedAndDoNotTouchIndependentDraftOrCursor() {
    var state = ConversationState()
    let cursor = state.historyCursor
    let draft = state.draft
    let ids = [UUID(), UUID(), UUID(), UUID()]
    _ = state.transition(.platformInterrupt(ids))
    #expect(state.platformCancellations.count == 2)
    #expect(state.draft == draft && state.historyCursor == cursor)
    _ = state.transition(.shutdown)
    let old = ReplySnapshot(
      responseId: UUID(), inputDeliveryId: ids[0], sequence: 0, state: .waiting, text: "")
    #expect(
      state.transition(.platformTargetLoaded(.init(generation: 0, id: 0), ids[0], old)).isEmpty)
  }
}

@MainActor struct PlatformInterruptionViewModelTests {
  @Test func exactCancellationWaitsForLocalStopAndPreservesIndependentDraft() async throws {
    let input = ConversationMessage(
      deliveryId: UUID(), recordId: 0, position: 0, text: "Accepted input")
    let reply = ReplySnapshot(
      responseId: UUID(), inputDeliveryId: input.deliveryId, sequence: 1, state: .streaming,
      text: "Partial")
    let backend = PlatformCancellationBackend(turn: CurrentTurn(input: input, reply: reply))
    let store = MemoryDraftStore()
    try await store.save(.editable(text: "Independent thought"))
    let model = ConversationViewModel(transport: backend, draftStore: store)
    await model.start()
    let gate = AsyncStream<Void>.makeStream()
    let stopped = Task { for await _ in gate.stream { break } }
    model.interruptForPlatform(handedInputIds: [], afterLocalStop: stopped)
    try await Task.sleep(for: .milliseconds(30))
    #expect(await backend.targets.isEmpty)
    #expect(model.draft == "Independent thought")
    gate.continuation.yield(())
    gate.continuation.finish()
    for _ in 0..<100 {
      if await !backend.targets.isEmpty { break }
      try await Task.sleep(for: .milliseconds(10))
    }
    #expect(await backend.targets == [reply.responseId])
    #expect(model.draft == "Independent thought" && model.pendingDelivery == nil)
    await model.shutdown()
  }
}

/// Typed in-memory cancellation ledger, independent of SDK or URLSession. The
/// public VM contract must respect the externally owned local-stop completion.
private actor PlatformCancellationBackend: ConversationTransport {
  let turn: CurrentTurn
  private(set) var targets: [UUID] = []
  init(turn: CurrentTurn) { self.turn = turn }
  func currentTurn() async throws -> CurrentTurn? { turn }
  func send(_ delivery: PendingDelivery) async throws -> ConversationMessage {
    throw ConversationFailure.unavailable
  }
  func history(after: Int?) async throws -> HistoryPage { throw ConversationFailure.unavailable }
  func interruptReply(responseId: UUID, inputDeliveryId: UUID) async throws -> ReplySnapshot? {
    guard inputDeliveryId == turn.input.deliveryId else { throw ConversationFailure.invalidInput }
    targets.append(responseId)
    return nil
  }
}
