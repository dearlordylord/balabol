import Foundation
import XCTest

@testable import Conversation

@MainActor
final class InterruptionTests: XCTestCase {
  func testNewInputFencesOldOutputAndRestoresInterruptedReceiptInOrder() async throws {
    let transport = InterruptingTransport()
    let model = ConversationViewModel(transport: transport, draftStore: MemoryDraftStore())
    await model.start()
    model.editDraft("First")
    await model.send()
    await transport.waitForObserver(count: 1)
    await transport.streamFirst()
    for _ in 0..<1000 {
      if model.replyText == "Partial" { break }
      await Task.yield()
    }
    XCTAssertEqual(model.replyText, "Partial")
    guard model.canSendDraft else {
      XCTFail("New input must be available during streaming.")
      await model.shutdown()
      return
    }
    model.editDraft("Correction")
    await model.send()
    await transport.waitForObserver(count: 2)
    await transport.emitLateFirstAndCompleteSecond()
    for _ in 0..<1000 {
      if model.messages.count == 4 { break }
      await Task.yield()
    }
    XCTAssertEqual(model.messages.map(\.text), ["First", "Partial", "Correction", "New answer"])
    XCTAssertEqual(model.messages.map(\.outcome), [nil, .interrupted, nil, .completed])
    XCTAssertNil(model.replyObservationFailure)
    XCTAssertNil(model.pendingDelivery)
    await model.shutdown()
    let restored = ConversationViewModel(transport: transport, draftStore: MemoryDraftStore())
    await restored.start()
    await restored.loadHistory()
    XCTAssertEqual(restored.messages, model.messages)
    await restored.shutdown()
  }

  func testStalledReceiptReadsBoundNewSendsAndShutdownRejectsTheirLateResults() async throws {
    let transport = InterruptingTransport(holdReceiptReads: true)
    let model = ConversationViewModel(transport: transport, draftStore: MemoryDraftStore())
    await model.start()
    for text in ["First", "Second", "Third"] {
      model.editDraft(text)
      await model.send()
    }
    await transport.waitForHeldReceipts(count: ConversationState.maximumInterruptionRecoveries)
    XCTAssertTrue(model.state.isWaitingForInterruptionRecovery)
    XCTAssertFalse(model.canSendDraft)
    XCTAssertTrue(model.canEditDraft)
    model.editDraft("Retain fourth draft")
    await model.send()
    XCTAssertEqual(model.draft, "Retain fourth draft")
    XCTAssertNil(model.pendingDelivery)
    XCTAssertEqual(model.messages.map(\.text), ["First", "Second", "Third"])
    await model.shutdown()
    let stopped = model.state
    await transport.releaseReceipts()
    for _ in 0..<100 { await Task.yield() }
    XCTAssertEqual(model.state, stopped)
  }

  func testQueuedOldOutputCannotApplyWhileNewAcceptanceIsPending() async throws {
    let transport = InterruptingTransport(holdSecondSend: true)
    let model = ConversationViewModel(transport: transport, draftStore: MemoryDraftStore())
    await model.start()
    model.editDraft("First")
    await model.send()
    await transport.waitForObserver(count: 1)
    await transport.streamFirst()
    for _ in 0..<1000 {
      if model.replyText == "Partial" { break }
      await Task.yield()
    }
    model.editDraft("Correction")
    let send = Task { await model.send() }
    await transport.waitForHeldAcceptance()
    await transport.emitLateFirst()
    for _ in 0..<100 { await Task.yield() }
    XCTAssertTrue(model.isSending)
    XCTAssertEqual(model.replyText, "")
    XCTAssertEqual(model.messages.map(\.text), ["First"])
    await transport.releaseAcceptance()
    await send.value
    await model.shutdown()
  }

  func testNewInputCanInterruptWaitingWithoutFabricatingText() async throws {
    let transport = InterruptingTransport()
    let model = ConversationViewModel(transport: transport, draftStore: MemoryDraftStore())
    await model.start()
    model.editDraft("First")
    await model.send()
    await transport.waitForObserver(count: 1)
    XCTAssertTrue(model.replyIsWaiting)
    XCTAssertTrue(model.canSendDraft)
    model.editDraft("Correction")
    await model.send()
    for _ in 0..<1000 {
      if model.messages.contains(where: { $0.outcome == .interrupted }) { break }
      await Task.yield()
    }
    let receipt = try XCTUnwrap(model.messages.first { $0.outcome == .interrupted })
    XCTAssertEqual(receipt.text, "")
    XCTAssertEqual(model.messages.map(\.text), ["First", "", "Correction"])
    await model.shutdown()
  }

  func testTargetedInterruptedReceiptDoesNotDrainUnloadedHistory() async throws {
    let transport = InterruptingTransport(backlog: HistoryPage.maximumMessages + 1)
    let model = ConversationViewModel(transport: transport, draftStore: MemoryDraftStore())
    await model.start()
    await model.loadHistory()
    XCTAssertEqual(model.messages.count, HistoryPage.maximumMessages)
    let cursor = model.state.historyCursor
    model.editDraft("First")
    await model.send()
    await transport.waitForObserver(count: 1)
    await transport.streamFirst()
    for _ in 0..<1000 {
      if model.replyText == "Partial" { break }
      await Task.yield()
    }
    model.editDraft("Correction")
    await model.send()
    for _ in 0..<1000 {
      if model.messages.contains(where: { $0.outcome == .interrupted }) { break }
      await Task.yield()
    }
    let interrupted = try XCTUnwrap(model.messages.first { $0.outcome == .interrupted })
    XCTAssertEqual(interrupted.text, "Partial")
    XCTAssertLessThan(interrupted.position, try XCTUnwrap(model.messages.last).position)
    XCTAssertEqual(model.state.historyCursor, cursor)
    XCTAssertFalse(model.messages.contains { $0.text == "Backlog 10" })
    XCTAssertNil(model.state.interruptedReceiptFailure)
    await model.shutdown()
  }

  func testLegacyAssistantOutcomeDefaultsCompletedAndNullOutcomeIsRejected() throws {
    let response = UUID()
    let input = UUID()
    let legacy =
      "{\"deliveryId\":\"\(response.uuidString)\",\"recordId\":1,\"position\":1,\"text\":\"Legacy reply\",\"role\":\"assistant\",\"responseId\":\"\(response.uuidString)\",\"inputDeliveryId\":\"\(input.uuidString)\"}"
    XCTAssertEqual(
      try JSONDecoder().decode(ConversationMessage.self, from: Data(legacy.utf8)).outcome,
      .completed)
    let nullOutcome = legacy.dropLast() + ",\"outcome\":null}"
    XCTAssertThrowsError(
      try JSONDecoder().decode(ConversationMessage.self, from: Data(nullOutcome.utf8)))
  }

  func testInterruptedTerminalWithNoTextIsDurableButEmptyCompletionIsInvalid() async throws {
    let transport = ControlledReplyTransport()
    let model = ConversationViewModel(transport: transport, draftStore: MemoryDraftStore())
    await model.start()
    model.editDraft("Input")
    await model.send()
    await transport.waitForObservation()
    let input = try XCTUnwrap(model.messages.first?.deliveryId)
    let response = UUID()
    let receipt = ConversationMessage(
      deliveryId: response, recordId: 8, position: 1, text: "", role: .assistant,
      responseId: response, inputDeliveryId: input, outcome: .interrupted)
    let interrupted = ReplySnapshot(
      responseId: response, inputDeliveryId: input, sequence: 1, state: .interrupted,
      text: "", receipt: receipt)
    let data = try JSONEncoder().encode(interrupted)
    XCTAssertEqual(try JSONDecoder().decode(ReplySnapshot.self, from: data), interrupted)
    XCTAssertFalse(
      ReplySnapshot(
        responseId: response, inputDeliveryId: input, sequence: 1, state: .completed,
        text: "", receipt: receipt
      ).isValid)
    XCTAssertFalse(
      ConversationMessage(
        deliveryId: UUID(), recordId: 9, position: 2, text: "User", outcome: .interrupted
      ).isValid)
    await transport.emit(interrupted)
    for _ in 0..<1000 {
      if model.messages.count == 2 { break }
      await Task.yield()
    }
    XCTAssertEqual(model.messages.last, receipt)
    XCTAssertFalse(model.isObservingReply)
    await model.shutdown()
  }
}

actor InterruptingTransport: ConversationTransport {
  private var messages: [ConversationMessage] = []
  private var collectedText = ""
  private var firstInput: UUID?
  private var secondInput: UUID?
  private let holdReceiptReads: Bool
  private var heldReceipts: [CheckedContinuation<Void, Never>] = []
  private let holdSecondSend: Bool
  private var heldAcceptance: CheckedContinuation<Void, Never>?
  init(backlog: Int = 0, holdSecondSend: Bool = false, holdReceiptReads: Bool = false) {
    self.holdReceiptReads = holdReceiptReads
    self.holdSecondSend = holdSecondSend
    messages = (0..<backlog).map {
      ConversationMessage(
        deliveryId: UUID(), recordId: $0, position: $0, text: "Backlog \($0)")
    }
  }
  private var observers: [AsyncThrowingStream<ReplySnapshot, any Error>.Continuation] = []
  private let firstResponse = UUID()
  private let secondResponse = UUID()
  func send(_ delivery: PendingDelivery) async throws -> ConversationMessage {
    if let firstInput {
      if holdSecondSend { await withCheckedContinuation { heldAcceptance = $0 } }
      let response = secondInput == nil ? firstResponse : secondResponse
      messages.append(
        ConversationMessage(
          deliveryId: response, recordId: messages.count, position: messages.count,
          text: collectedText, role: .assistant,
          responseId: response, inputDeliveryId: secondInput ?? firstInput, outcome: .interrupted))
    }
    let receipt = ConversationMessage(
      deliveryId: delivery.deliveryId, recordId: messages.count, position: messages.count,
      text: delivery.text)
    messages.append(receipt)
    if firstInput == nil {
      firstInput = delivery.deliveryId
    } else {
      secondInput = delivery.deliveryId
    }
    return receipt
  }
  func replySnapshot(for inputDeliveryId: UUID) async throws -> ReplySnapshot {
    if holdReceiptReads { await withCheckedContinuation { heldReceipts.append($0) } }
    guard let receipt = messages.first(where: { $0.inputDeliveryId == inputDeliveryId }) else {
      throw ConversationFailure.unavailable
    }
    return ReplySnapshot(
      responseId: receipt.deliveryId, inputDeliveryId: inputDeliveryId,
      sequence: 2, state: receipt.outcome == .interrupted ? .interrupted : .completed,
      text: receipt.text, receipt: receipt)
  }
  func history(after: Int?) async throws -> HistoryPage {
    let remaining = messages.filter { $0.position > (after ?? -1) }
    let page = Array(remaining.prefix(HistoryPage.maximumMessages))
    return HistoryPage(
      messages: page, nextAfter: remaining.count > page.count ? page.last?.position : nil)
  }
  func observeReply(for inputDeliveryId: UUID) async throws -> ReplyObservation {
    let stream = AsyncThrowingStream<ReplySnapshot, any Error>.makeStream()
    observers.append(stream.continuation)
    // Deliberately uncooperative cancellation exercises queued late callbacks.
    return ReplyObservation(events: stream.stream, cancel: {})
  }
  func waitForObserver(count: Int) async {
    for _ in 0..<1000 {
      if observers.count >= count { return }
      await Task.yield()
    }
  }
  func streamFirst() {
    collectedText = "Partial"
    guard let firstInput, let observer = observers.first else { return }
    observer.yield(
      ReplySnapshot(
        responseId: firstResponse, inputDeliveryId: firstInput, sequence: 1,
        state: .streaming, text: "Partial"))
  }
  func waitForHeldReceipts(count: Int) async {
    for _ in 0..<1000 {
      if heldReceipts.count >= count { return }
      await Task.yield()
    }
  }
  func releaseReceipts() {
    heldReceipts.forEach { $0.resume() }
    heldReceipts.removeAll()
  }
  func waitForHeldAcceptance() async {
    for _ in 0..<1000 {
      if heldAcceptance != nil { return }
      await Task.yield()
    }
  }
  func releaseAcceptance() {
    heldAcceptance?.resume()
    heldAcceptance = nil
  }
  func emitLateFirst() {
    guard let firstInput, let observer = observers.first else { return }
    observer.yield(
      ReplySnapshot(
        responseId: firstResponse, inputDeliveryId: firstInput,
        sequence: 2, state: .streaming, text: "Partial late output"))
    let stale = ConversationMessage(
      deliveryId: firstResponse, recordId: 1, position: 1, text: "Partial late completion",
      role: .assistant, responseId: firstResponse, inputDeliveryId: firstInput)
    observer.yield(
      ReplySnapshot(
        responseId: firstResponse, inputDeliveryId: firstInput, sequence: 3,
        state: .completed, text: stale.text, receipt: stale))
  }
  func emitLateFirstAndCompleteSecond() {
    guard let firstInput, let secondInput, observers.count == 2 else { return }
    observers[0].yield(
      ReplySnapshot(
        responseId: firstResponse, inputDeliveryId: firstInput, sequence: 2,
        state: .streaming, text: "Partial stale output"))
    let receipt = ConversationMessage(
      deliveryId: secondResponse, recordId: messages.count, position: messages.count,
      text: "New answer", role: .assistant,
      responseId: secondResponse, inputDeliveryId: secondInput)
    messages.append(receipt)
    observers[1].yield(
      ReplySnapshot(
        responseId: secondResponse, inputDeliveryId: secondInput, sequence: 2,
        state: .completed, text: receipt.text, receipt: receipt))
    observers.forEach { $0.finish() }
  }
}
