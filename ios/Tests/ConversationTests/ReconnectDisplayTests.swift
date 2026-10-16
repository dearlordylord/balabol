import XCTest

@testable import Conversation

@MainActor final class ReconnectDisplayTests: XCTestCase {
  func testReconnectMergesTailAndCurrentWithoutMovingCursorDraftOrStartingObserver() async throws {
    let transport = ReconnectDisplayTransport()
    let store = MemoryDraftStore()
    let model = ConversationViewModel(transport: transport, draftStore: store)
    await model.start()
    await model.loadHistory()
    model.editDraft("Independent draft")
    await model.flushDraft()
    let cursor = 6
    let next = model.nextBefore
    await transport.exposeCurrent()
    model.refreshReconnectDisplay()
    await settle { model.messages.count == 3 }
    XCTAssertEqual(model.state.historyCursor, cursor)
    XCTAssertEqual(model.nextBefore, next)
    XCTAssertEqual(model.draft, "Independent draft")
    XCTAssertNil(model.pendingDelivery)
    XCTAssertEqual(model.messages.map(\.text), ["Earlier", "Voice input", "Answer"])
    if case .completed(let receipt) = model.state.reply {
      XCTAssertEqual(receipt.text, "Answer")
    } else {
      XCTFail("Expected durable completed reply projection")
    }
    let observers = await transport.observers
    XCTAssertEqual(observers, 0)
    await model.shutdown()
  }

  func testLateReconnectDisplayCannotReplaceNewerInputOrTerminalReply() async throws {
    let transport = ReconnectDisplayTransport()
    let model = ConversationViewModel(transport: transport, draftStore: MemoryDraftStore())
    await model.start()
    await model.loadHistory()
    await transport.exposeCurrent(hold: true)
    model.refreshReconnectDisplay()
    for _ in 0..<300 {
      if await transport.waiting() { break }
      try await Task.sleep(for: .milliseconds(5))
    }
    let newer = ConversationMessage(deliveryId: UUID(), recordId: 10, position: 10, text: "Newer")
    model.acceptVoiceReceipt(newer)
    model.editDraft("Still mine")
    await model.flushDraft()
    await transport.release()
    await settle { model.messages.count == 4 }
    XCTAssertEqual(model.messages.last, newer)
    XCTAssertEqual(model.state.reply, .idle)
    XCTAssertEqual(model.state.historyCursor, 6)
    XCTAssertEqual(model.draft, "Still mine")
    let observers = await transport.observers
    XCTAssertEqual(observers, 0)
    await model.shutdown()
  }

  private func settle(_ ready: () -> Bool) async {
    for _ in 0..<300 {
      if ready() { return }
      try? await Task.sleep(for: .milliseconds(5))
    }
    XCTFail("Reconnect display did not settle")
  }
}

private actor ReconnectDisplayTransport: ConversationTransport {
  private let first = ConversationMessage(
    deliveryId: UUID(), recordId: 0, position: 0, text: "Earlier")
  private let input = ConversationMessage(
    deliveryId: UUID(), recordId: 5, position: 5, text: "Voice input")
  private let response = UUID()
  private var exposed = false
  private var hold = false
  private var gate: CheckedContinuation<Void, Never>?
  private(set) var observers = 0
  func exposeCurrent(hold: Bool = false) {
    exposed = true
    self.hold = hold
  }
  func waiting() -> Bool { gate != nil }
  func release() {
    hold = false
    gate?.resume()
    gate = nil
  }
  private var receipt: ConversationMessage {
    ConversationMessage(
      deliveryId: response, recordId: 6, position: 6, text: "Answer", role: .assistant,
      responseId: response, inputDeliveryId: input.deliveryId)
  }
  func send(_ delivery: PendingDelivery) async throws -> ConversationMessage {
    throw ConversationFailure.unavailable
  }
  func history(after: Int?) async throws -> HistoryPage {
    if after == nil { return HistoryPage(messages: [first], nextAfter: nil) }
    if hold { await withCheckedContinuation { gate = $0 } }
    return HistoryPage(messages: [input, receipt], nextAfter: nil)
  }
  func currentTurn() async throws -> CurrentTurn? {
    guard exposed else { return nil }
    return CurrentTurn(
      input: input,
      reply: ReplySnapshot(
        responseId: response,
        inputDeliveryId: input.deliveryId, sequence: 8, state: .completed, text: "Answer",
        receipt: receipt))
  }
  func observeReply(for inputDeliveryId: UUID) async throws -> ReplyObservation {
    observers += 1
    throw ConversationFailure.unavailable
  }
}
