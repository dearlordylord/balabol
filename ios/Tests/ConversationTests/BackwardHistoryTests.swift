import XCTest

@testable import Conversation

@MainActor final class BackwardHistoryTests: XCTestCase {
  func testLatestWindowThenOlderPagesAndLargeForwardGapRemainContiguous() async {
    let transport = LedgerHistoryTransport(count: 251)
    let model = ConversationViewModel(transport: transport, draftStore: MemoryDraftStore())
    await model.start()
    await model.loadOlderHistory()
    XCTAssertEqual(model.messages.map(\.position), Array(151..<251))
    XCTAssertEqual(model.nextBefore, 151)
    await model.loadOlderHistory()
    XCTAssertEqual(model.messages.map(\.position), Array(51..<251))
    XCTAssertEqual(model.nextBefore, 51)
    await transport.append(125)
    await model.refreshHistory()
    XCTAssertEqual(model.messages.map(\.position), Array(51..<376))
    XCTAssertEqual(model.nextBefore, 51)
    await model.loadOlderHistory()
    XCTAssertEqual(model.messages.map(\.position), Array(0..<376))
    XCTAssertNil(model.nextBefore)
    let reads = await transport.forwardReads
    XCTAssertEqual(reads, 13)
    await model.shutdown()
  }

  func testCatchUpFailureRetainsAcceptedPageProgressAndOlderCursorForRetry() async {
    let transport = LedgerHistoryTransport(count: 151)
    let model = ConversationViewModel(transport: transport, draftStore: MemoryDraftStore())
    await model.start()
    await model.loadOlderHistory()
    await transport.append(25)
    await transport.failForwardRead(2)
    await model.refreshHistory()
    XCTAssertEqual(model.state.historyCursor, 160)
    XCTAssertEqual(model.nextBefore, 51)
    XCTAssertEqual(model.historyFailure, .unavailable)
    await model.refreshHistory()
    XCTAssertEqual(model.messages.map(\.position), Array(51..<176))
    XCTAssertEqual(model.nextBefore, 51)
    XCTAssertNil(model.historyFailure)
    await model.shutdown()
  }

  func testForegroundRefreshQueuedDuringOlderReadRunsAfterPageCompletes() async {
    let transport = LedgerHistoryTransport(count: 151)
    let model = ConversationViewModel(transport: transport, draftStore: MemoryDraftStore())
    await model.start()
    await model.loadOlderHistory()
    await transport.holdOlder()
    let older = Task { await model.loadOlderHistory() }
    while !(await transport.isHolding()) { await Task.yield() }
    await transport.append(25)
    let refresh = Task { await model.refreshHistory() }
    while !model.state.historyRefreshPending { await Task.yield() }
    await transport.releaseOlder()
    await older.value
    await refresh.value
    XCTAssertEqual(model.messages.map(\.position), Array(0..<176))
    XCTAssertNil(model.nextBefore)
    XCTAssertEqual(model.state.historyCursor, 175)
    await model.shutdown()
  }

  func testReconnectDoesNotSkipGapAfterDirectVoiceReceipt() async {
    let transport = LedgerHistoryTransport(count: 101)
    let model = ConversationViewModel(transport: transport, draftStore: MemoryDraftStore())
    await model.start()
    await model.loadOlderHistory()
    await transport.append(125)
    let latest = await transport.last()
    model.acceptVoiceReceipt(latest)
    model.refreshReconnectDisplay()
    for _ in 0..<1000 {
      if model.state.historyCursor == 225 { break }
      await Task.yield()
    }
    XCTAssertEqual(model.messages.map(\.position), Array(1..<226))
    XCTAssertEqual(model.nextBefore, 1)
    await model.shutdown()
  }
}

private actor LedgerHistoryTransport: ConversationTransport {
  private var messages: [ConversationMessage] = []
  private(set) var forwardReads = 0
  private var failingRead: Int?
  private var shouldHold = false
  private var gate: CheckedContinuation<Void, Never>?
  func holdOlder() { shouldHold = true }
  func isHolding() -> Bool { gate != nil }
  func releaseOlder() {
    shouldHold = false
    gate?.resume()
    gate = nil
  }
  func failForwardRead(_ number: Int) { failingRead = number }
  init(count: Int) {
    messages = (0..<count).map {
      ConversationMessage(deliveryId: UUID(), recordId: $0, position: $0, text: "Message \($0)")
    }
  }
  func append(_ count: Int) {
    let start = messages.count
    messages += (start..<(start + count)).map {
      ConversationMessage(deliveryId: UUID(), recordId: $0, position: $0, text: "Message \($0)")
    }
  }
  func last() -> ConversationMessage { messages[messages.count - 1] }
  func send(_ delivery: PendingDelivery) async throws -> ConversationMessage {
    throw ConversationFailure.unavailable
  }
  func olderHistory(before: Int?) async throws -> OlderHistoryPage {
    if shouldHold { await withCheckedContinuation { gate = $0 } }
    let eligible = messages.filter { message in before.map { message.position < $0 } ?? true }
    let page = Array(eligible.suffix(OlderHistoryPage.maximumMessages))
    return OlderHistoryPage(
      messages: page, nextBefore: eligible.count > page.count ? page.first?.position : nil)
  }
  func history(after: Int?) async throws -> HistoryPage {
    forwardReads += 1
    if forwardReads == failingRead { throw ConversationFailure.unavailable }
    let eligible = messages.filter { $0.position > (after ?? -1) }
    let page = Array(eligible.prefix(HistoryPage.maximumMessages))
    return HistoryPage(
      messages: page, nextAfter: eligible.count > page.count ? page.last?.position : nil)
  }
}
