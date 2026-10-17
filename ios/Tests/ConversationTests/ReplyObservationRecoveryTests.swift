import XCTest

@testable import Conversation

final class ReplyObservationRecoveryTests: XCTestCase {
  func testDisconnectSchedulesRecoveryWithoutLosingTextOrRetryingGeneration() {
    var state = ConversationState()
    let input = UUID()
    let response = UUID()
    let request = ConversationState.Request(generation: 0, id: 1)
    let snapshot = ReplySnapshot(
      responseId: response, inputDeliveryId: input, sequence: 3,
      state: .delivering, text: "Still speaking")
    state.reply = .observing(request, inputDeliveryId: input, latest: snapshot)
    let commands = state.transition(.replyEnded(request, .unavailable))
    XCTAssertFalse(commands.isEmpty, "A lost observer must schedule authoritative recovery")
    XCTAssertNil(state.replyObservationFailure, "A reconnecting observer is not a failed reply")
    XCTAssertEqual(state.replyText, snapshot.text)
    XCTAssertFalse(commands.contains { if case .retryReply = $0 { true } else { false } })
  }
}

extension ReplyObservationRecoveryTests {
  private func disconnected() -> (ConversationState, ConversationState.Request, ReplySnapshot) {
    var state = ConversationState()
    let original = ConversationState.Request(generation: 0, id: 100)
    let snapshot = ReplySnapshot(
      responseId: UUID(), inputDeliveryId: UUID(), sequence: 3,
      state: .delivering, text: "Still speaking")
    state.reply = .observing(original, inputDeliveryId: snapshot.inputDeliveryId, latest: snapshot)
    _ = state.transition(.replyEnded(original, .unavailable))
    guard case .recovering(let request, _, _, _) = state.reply else {
      fatalError("Expected recovery")
    }
    return (state, request, snapshot)
  }

  func testRecoveryReadsDurableCompletionWithoutAnotherModelRequest() {
    var (state, request, previous) = disconnected()
    let receipt = ConversationMessage(
      deliveryId: previous.responseId, recordId: 8, position: 1,
      text: previous.text, role: .assistant, responseId: previous.responseId,
      inputDeliveryId: previous.inputDeliveryId)
    let completed = ReplySnapshot(
      responseId: previous.responseId,
      inputDeliveryId: previous.inputDeliveryId, sequence: 4, state: .completed,
      text: previous.text, receipt: receipt)
    let commands = state.transition(.observationRecovered(request, .success(completed)))
    XCTAssertEqual(state.messages, [receipt])
    XCTAssertEqual(state.reply, .completed(receipt))
    XCTAssertNil(state.replyObservationFailure)
    XCTAssertEqual(commands.count, 1)
    guard case .cancelReply = commands.first else { return XCTFail("Only cancel observation") }
  }

  func testUnavailableReadBacksOffAndResumesSameReply() {
    var (state, request, snapshot) = disconnected()
    for attempt in 2...8 {
      _ = state.transition(.observationRecovered(request, .failure(.unavailable)))
      guard case .recovering(let next, let input, let latest, let delay) = state.reply else {
        return XCTFail("Must keep recovering")
      }
      XCTAssertEqual(input, snapshot.inputDeliveryId)
      XCTAssertEqual(latest, snapshot)
      XCTAssertEqual(delay, min(attempt, 5))
      request = next
    }
    let commands = state.transition(.observationRecovered(request, .success(snapshot)))
    XCTAssertTrue(state.isObservingReply)
    XCTAssertEqual(state.replyText, snapshot.text)
    guard case .observeReply(let observer, let input) = commands.last else {
      return XCTFail("Must resume observation")
    }
    XCTAssertEqual(observer, request)
    XCTAssertEqual(input, snapshot.inputDeliveryId)
  }

  func testLateRecoveryCannotDisplaceNewerReplyOrReviveShutdown() {
    var (state, request, snapshot) = disconnected()
    let newer = ConversationState.Request(generation: 0, id: 200)
    state.reply = .observing(newer, inputDeliveryId: UUID(), latest: nil)
    let before = state
    XCTAssertTrue(state.transition(.observationRecovered(request, .success(snapshot))).isEmpty)
    XCTAssertEqual(state, before)
    var (stopping, pending, previous) = disconnected()
    _ = stopping.transition(.shutdown)
    let stopped = stopping
    XCTAssertTrue(stopping.transition(.observationRecovered(pending, .success(previous))).isEmpty)
    XCTAssertEqual(stopping, stopped)
  }

  func testMalformedReadStopsRecoveryAndRemainsExplicit() {
    var (state, request, snapshot) = disconnected()
    XCTAssertTrue(
      state.transition(.observationRecovered(request, .failure(.invalidResponse))).isEmpty)
    XCTAssertEqual(state.replyObservationFailure, .invalidResponse)
    XCTAssertEqual(state.replyText, snapshot.text)
  }

  func testSessionResourceBudgetIncludesFullVoiceDelivery() {
    let configuration = HTTPConversationTransport.sessionConfiguration()
    XCTAssertGreaterThan(configuration.timeoutIntervalForResource, 300)
    XCTAssertEqual(configuration.timeoutIntervalForRequest, 20)
  }
}

extension ReplyObservationRecoveryTests {
  @MainActor
  func testViewModelRecoversSavedReplyAfterStreamDisconnectWithoutResending() async throws {
    let transport = DisconnectedReplyTransport()
    let model = ConversationViewModel(transport: transport, draftStore: MemoryDraftStore())
    await model.start()
    model.editDraft("Input")
    await model.send()
    for _ in 0..<100 {
      if model.messages.count == 2 { break }
      try await Task.sleep(for: .milliseconds(20))
    }
    XCTAssertEqual(model.messages.map(\.role), [.user, .assistant])
    XCTAssertEqual(model.messages.last?.text, "Saved reply")
    XCTAssertNil(model.replyObservationFailure)
    let counts = await transport.counts
    XCTAssertEqual(counts.send, 1)
    XCTAssertEqual(counts.read, 1)
    XCTAssertEqual(counts.retry, 0)
    await model.shutdown()
  }
}

private actor DisconnectedReplyTransport: ConversationTransport {
  private var input: UUID?
  private let response = UUID()
  private var sends = 0
  private var reads = 0
  private var retries = 0
  var counts: (send: Int, read: Int, retry: Int) { (sends, reads, retries) }
  func send(_ delivery: PendingDelivery) async throws -> ConversationMessage {
    sends += 1
    input = delivery.deliveryId
    return ConversationMessage(
      deliveryId: delivery.deliveryId, recordId: 0, position: 0,
      text: delivery.text)
  }
  func history(after: Int?) async throws -> HistoryPage {
    HistoryPage(messages: [], nextAfter: nil)
  }
  func observeReply(for inputDeliveryId: UUID) async throws -> ReplyObservation {
    let stream = AsyncThrowingStream<ReplySnapshot, any Error>.makeStream()
    stream.continuation.yield(
      ReplySnapshot(
        responseId: response,
        inputDeliveryId: inputDeliveryId, sequence: 1, state: .delivering, text: "Saved reply"))
    stream.continuation.finish(throwing: ConversationFailure.unavailable)
    return ReplyObservation(events: stream.stream, cancel: { stream.continuation.finish() })
  }
  func replySnapshot(for inputDeliveryId: UUID) async throws -> ReplySnapshot {
    guard input == inputDeliveryId else { throw ConversationFailure.invalidInput }
    reads += 1
    let receipt = ConversationMessage(
      deliveryId: response, recordId: 1, position: 1,
      text: "Saved reply", role: .assistant, responseId: response,
      inputDeliveryId: inputDeliveryId)
    return ReplySnapshot(
      responseId: response, inputDeliveryId: inputDeliveryId,
      sequence: 2, state: .completed, text: receipt.text, receipt: receipt)
  }
  func retryReply(for inputDeliveryId: UUID) async throws -> ReplySnapshot {
    retries += 1
    throw ConversationFailure.invalidInput
  }
}
