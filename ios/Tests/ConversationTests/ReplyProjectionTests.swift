import XCTest

@testable import Conversation

@MainActor
final class ReplyProjectionTests: XCTestCase {
  func testProgressiveReplyBecomesHistoryOnlyAfterDurableCompletion() async throws {
    let transport = ControlledReplyTransport()
    let model = ConversationViewModel(transport: transport, draftStore: MemoryDraftStore())
    await model.start()
    model.editDraft("Hello")
    await model.send()
    await transport.waitForObservation()
    let input = try XCTUnwrap(model.messages.first?.deliveryId)
    let response = UUID()
    await transport.emit(
      ReplySnapshot(
        responseId: response, inputDeliveryId: input, sequence: 2, state: .streaming, text: "Demo"))
    for _ in 0..<1000 {
      if model.replyText == "Demo" { break }
      await Task.yield()
    }
    XCTAssertEqual(model.replyText, "Demo")
    XCTAssertEqual(model.messages.map(\.role), [.user])
    let receipt = ConversationMessage(
      deliveryId: response, recordId: 8, position: 1, text: "Demo answer", role: .assistant,
      responseId: response, inputDeliveryId: input)
    await transport.emit(
      ReplySnapshot(
        responseId: response, inputDeliveryId: input, sequence: 5, state: .completed,
        text: receipt.text, receipt: receipt))
    for _ in 0..<1000 {
      if model.messages.count == 2 { break }
      await Task.yield()
    }
    XCTAssertEqual(model.messages.map(\.text), ["Hello", "Demo answer"])
    XCTAssertNil(model.replyObservationFailure)
    await model.shutdown()
  }
}

actor ControlledReplyTransport: ConversationTransport {
  private let historyMessages: [ConversationMessage]
  init(historyMessages: [ConversationMessage] = []) { self.historyMessages = historyMessages }
  private var continuation: AsyncThrowingStream<ReplySnapshot, any Error>.Continuation?
  private var waiting: CheckedContinuation<Void, Never>?
  private(set) var observationCount = 0
  func send(_ delivery: PendingDelivery) async throws -> ConversationMessage {
    ConversationMessage(
      deliveryId: delivery.deliveryId, recordId: 7, position: 0, text: delivery.text)
  }
  func history(after: Int?) async throws -> HistoryPage {
    HistoryPage(messages: historyMessages, nextAfter: nil)
  }
  func observeReply(for inputDeliveryId: UUID) async throws -> ReplyObservation {
    let stream = AsyncThrowingStream<ReplySnapshot, any Error>.makeStream(
      bufferingPolicy: .bufferingOldest(16))
    continuation = stream.continuation
    observationCount += 1
    waiting?.resume()
    waiting = nil
    return ReplyObservation(events: stream.stream, cancel: { stream.continuation.finish() })
  }
  func waitForObservation() async {
    if continuation != nil { return }
    await withCheckedContinuation { waiting = $0 }
  }
  func emit(_ snapshot: ReplySnapshot) { continuation?.yield(snapshot) }
  func failObservation() { continuation?.finish(throwing: ConversationFailure.unavailable) }
}

@MainActor
final class ReplyValidationTests: XCTestCase {
  func testDuplicateStaleAndPostTerminalSnapshotsCannotRewriteCompletedHistory() async throws {
    let transport = ControlledReplyTransport()
    let model = ConversationViewModel(transport: transport, draftStore: MemoryDraftStore())
    await model.start()
    model.editDraft("Input")
    await model.send()
    await transport.waitForObservation()
    let input = try XCTUnwrap(model.messages.first?.deliveryId)
    let response = UUID()
    let first = ReplySnapshot(
      responseId: response, inputDeliveryId: input, sequence: 2, state: .streaming, text: "Demo")
    await transport.emit(first)
    for _ in 0..<1000 {
      if model.replyText == "Demo" { break }
      await Task.yield()
    }
    await transport.emit(first)
    await transport.emit(
      ReplySnapshot(
        responseId: response, inputDeliveryId: input, sequence: 1, state: .streaming, text: "Stale")
    )
    let receipt = ConversationMessage(
      deliveryId: response, recordId: 8, position: 1, text: "Demo done", role: .assistant,
      responseId: response, inputDeliveryId: input)
    await transport.emit(
      ReplySnapshot(
        responseId: response, inputDeliveryId: input, sequence: 3, state: .completed,
        text: receipt.text, receipt: receipt))
    for _ in 0..<1000 {
      if model.messages.count == 2 { break }
      await Task.yield()
    }
    await transport.emit(
      ReplySnapshot(
        responseId: response, inputDeliveryId: input, sequence: 4, state: .streaming,
        text: "Demo done late"))
    XCTAssertEqual(model.messages.last, receipt)
    XCTAssertEqual(model.replyText, "")
    XCTAssertNil(model.replyObservationFailure)
    await model.shutdown()
  }

  func testConflictingSequenceFailsObservationWithoutFabricatingProviderFailure() async throws {
    let transport = ControlledReplyTransport()
    let model = ConversationViewModel(transport: transport, draftStore: MemoryDraftStore())
    await model.start()
    model.editDraft("Input")
    await model.send()
    await transport.waitForObservation()
    let input = try XCTUnwrap(model.messages.first?.deliveryId)
    let response = UUID()
    await transport.emit(
      ReplySnapshot(
        responseId: response, inputDeliveryId: input, sequence: 1, state: .streaming,
        text: "Original"))
    for _ in 0..<1000 {
      if model.replyText == "Original" { break }
      await Task.yield()
    }
    await transport.emit(
      ReplySnapshot(
        responseId: response, inputDeliveryId: input, sequence: 1, state: .streaming,
        text: "Changed"))
    for _ in 0..<1000 {
      if model.replyObservationFailure != nil { break }
      await Task.yield()
    }
    XCTAssertEqual(model.replyObservationFailure, .invalidResponse)
    XCTAssertNil(model.replyProviderFailure)
    XCTAssertEqual(model.replyText, "Original")
    XCTAssertEqual(model.messages.count, 1)
    await model.shutdown()
  }

  func testPendingContextFailsHonestlyWithoutDurableAssistantHistory() async throws {
    let transport = ControlledReplyTransport()
    let model = ConversationViewModel(transport: transport, draftStore: MemoryDraftStore())
    await model.start()
    model.editDraft("Input")
    await model.send()
    await transport.waitForObservation()
    let input = try XCTUnwrap(model.messages.first?.deliveryId)
    let failure = ReplyFailure(
      code: .memoryPending, message: "Prior context did not become ready within the bound.")
    await transport.emit(
      ReplySnapshot(
        responseId: UUID(), inputDeliveryId: input, sequence: 3, state: .failed, text: "",
        error: failure))
    for _ in 0..<1000 {
      if model.replyProviderFailure != nil { break }
      await Task.yield()
    }
    XCTAssertEqual(model.replyProviderFailure, failure)
    XCTAssertNil(model.replyObservationFailure)
    XCTAssertEqual(model.messages.count, 1)
    XCTAssertNil(model.pendingDelivery)
    await model.shutdown()
  }
}

@MainActor
final class ReplyLifetimeTests: XCTestCase {
  func testShutdownPreservesPartialProjectionButRejectsLateCompletion() async throws {
    let transport = ControlledReplyTransport()
    let model = ConversationViewModel(transport: transport, draftStore: MemoryDraftStore())
    await model.start()
    model.editDraft("Input")
    await model.send()
    await transport.waitForObservation()
    let input = try XCTUnwrap(model.messages.first?.deliveryId)
    let response = UUID()
    await transport.emit(
      ReplySnapshot(
        responseId: response, inputDeliveryId: input, sequence: 0, state: .waiting, text: ""))
    await transport.emit(
      ReplySnapshot(
        responseId: response, inputDeliveryId: input, sequence: 1, state: .streaming,
        text: "Partial"))
    for _ in 0..<1000 {
      if model.replyText == "Partial" { break }
      await Task.yield()
    }
    XCTAssertEqual(model.replyText, "Partial")
    await model.shutdown()
    let stopped = model.state
    let receipt = ConversationMessage(
      deliveryId: response, recordId: 8, position: 1, text: "Partial complete", role: .assistant,
      responseId: response, inputDeliveryId: input)
    await transport.emit(
      ReplySnapshot(
        responseId: response, inputDeliveryId: input, sequence: 2, state: .completed,
        text: receipt.text, receipt: receipt))
    XCTAssertEqual(model.state, stopped)
    XCTAssertEqual(model.messages.count, 1)
  }

  func testLegacyHistoryWithoutRoleMetadataStillDecodesAsUser() async throws {
    let id = UUID()
    let data = Data(
      "{\"messages\":[{\"deliveryId\":\"\(id.uuidString)\",\"recordId\":7,\"position\":0,\"text\":\"Legacy\"}],\"nextAfter\":null}"
        .utf8)
    let page = try JSONDecoder().decode(HistoryPage.self, from: data)
    let model = ConversationViewModel(
      transport: PageTransport(pages: [page]), draftStore: MemoryDraftStore())
    await model.start()
    await model.loadHistory()
    XCTAssertEqual(model.messages.map(\.role), [.user])
    XCTAssertEqual(model.messages.map(\.text), ["Legacy"])
    await model.shutdown()
  }
}

@MainActor
final class ReplyReconnectTests: XCTestCase {
  func testFreshObserverAcceptsAuthoritativeRestartFailureWithResetSequence() async throws {
    let transport = ControlledReplyTransport()
    let model = ConversationViewModel(transport: transport, draftStore: MemoryDraftStore())
    await model.start()
    model.editDraft("Input")
    await model.send()
    await transport.waitForObservation()
    let input = try XCTUnwrap(model.messages.first?.deliveryId)
    await transport.emit(
      ReplySnapshot(
        responseId: UUID(), inputDeliveryId: input, sequence: 9, state: .streaming,
        text: "Prior partial"))
    for _ in 0..<1000 {
      if model.replyText == "Prior partial" { break }
      await Task.yield()
    }
    await transport.failObservation()
    for _ in 0..<1000 {
      if model.replyObservationFailure != nil { break }
      await Task.yield()
    }
    await model.refreshHistory()
    for _ in 0..<1000 {
      if await transport.observationCount == 2 { break }
      await Task.yield()
    }
    let failure = ReplyFailure(
      code: .restarted, message: "The server restarted before completing this reply.")
    await transport.emit(
      ReplySnapshot(
        responseId: UUID(), inputDeliveryId: input, sequence: 0, state: .failed, text: "",
        error: failure))
    for _ in 0..<1000 {
      if model.replyProviderFailure != nil || model.replyObservationFailure != nil { break }
      await Task.yield()
    }
    XCTAssertEqual(model.replyProviderFailure, failure)
    XCTAssertNil(model.replyObservationFailure)
    XCTAssertEqual(model.messages.count, 1)
    await model.shutdown()
  }
}

@MainActor
final class ReplyAcceptanceTests: XCTestCase {
  func testHistoryAcknowledgementOfUncertainInputStartsReplyObservation() async throws {
    let pending = PendingDelivery(deliveryId: UUID(), text: "Previously accepted")
    let accepted = ConversationMessage(
      deliveryId: pending.deliveryId, recordId: 7, position: 0, text: pending.text)
    let transport = ControlledReplyTransport(historyMessages: [accepted])
    let store = MemoryDraftStore()
    try await store.save(.awaitingReceipt(pending))
    let model = ConversationViewModel(transport: transport, draftStore: store)
    await model.start()
    await model.loadHistory()
    for _ in 0..<1000 {
      if await transport.observationCount == 1 { break }
      await Task.yield()
    }
    let count = await transport.observationCount
    XCTAssertEqual(count, 1)
    XCTAssertNil(model.pendingDelivery)
    XCTAssertTrue(model.replyIsWaiting)
    await model.shutdown()
  }

  func testProviderFailurePreservesPartialWithoutAcceptingAssistantRecord() async throws {
    let transport = ControlledReplyTransport()
    let model = ConversationViewModel(transport: transport, draftStore: MemoryDraftStore())
    await model.start()
    model.editDraft("Input")
    await model.send()
    await transport.waitForObservation()
    let input = try XCTUnwrap(model.messages.first?.deliveryId)
    let response = UUID()
    await transport.emit(
      ReplySnapshot(
        responseId: response, inputDeliveryId: input, sequence: 1, state: .streaming,
        text: "Partial"))
    for _ in 0..<1000 {
      if model.replyText == "Partial" { break }
      await Task.yield()
    }
    let error = ReplyFailure(code: .providerFailed, message: "Provider stopped before completion.")
    await transport.emit(
      ReplySnapshot(
        responseId: response, inputDeliveryId: input, sequence: 2, state: .failed, text: "Partial",
        error: error))
    for _ in 0..<1000 {
      if model.replyProviderFailure != nil { break }
      await Task.yield()
    }
    XCTAssertEqual(model.replyProviderFailure, error)
    XCTAssertEqual(model.replyText, "Partial")
    XCTAssertEqual(model.messages.map(\.role), [.user])
    await model.shutdown()
  }
}

@MainActor
final class ReplyContractTests: XCTestCase {
  func testUnknownProviderTerminalCodeCannotEnterValidatedSnapshot() {
    let response = UUID()
    let input = UUID()
    let data = Data(
      "{\"responseId\":\"\(response.uuidString)\",\"inputDeliveryId\":\"\(input.uuidString)\",\"sequence\":0,\"state\":\"Failed\",\"text\":\"\",\"error\":{\"code\":\"UnknownProviderCode\",\"message\":\"Unsupported terminal outcome\"},\"receipt\":null}"
        .utf8)
    XCTAssertThrowsError(try JSONDecoder().decode(ReplySnapshot.self, from: data))
  }
}
