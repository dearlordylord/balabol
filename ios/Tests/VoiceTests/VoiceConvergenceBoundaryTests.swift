import Foundation
import XCTest

@testable import Conversation
@testable import Voice

@MainActor final class VoiceConvergenceBoundaryTests: XCTestCase {
  func testCanonicalTerminalConvergesAfterLostAcknowledgementAndObserversWithoutRegeneration()
    async throws
  {
    let environment = ProcessInfo.processInfo.environment
    guard let address = environment["BALABOL_CONVERGENCE_ORIGIN"],
      let origin = URL(string: address),
      let controls = environment["BALABOL_CONVERGENCE_CONTROL_ORIGIN"],
      let controlOrigin = URL(string: controls)
    else {
      throw XCTSkip(
        "Run scripts/quint/check-convergence.mjs for the isolated real-server acceptance.")
    }
    let session = URLSession(configuration: .ephemeral)
    defer { session.invalidateAndCancel() }
    let realConversation = try HTTPConversationTransport(baseURL: origin, session: session)
    let transport = ConvergenceConversationTransport(realConversation)
    let control = ConvergenceVoiceControl(try HTTPVoiceControl(baseURL: origin, session: session))
    let media = ConvergenceMedia()
    var voice: VoiceViewModel?
    let conversation = ConversationViewModel(
      transport: transport, draftStore: MemoryDraftStore(), inputIntent: { voice?.inputIntent($0) })
    voice = VoiceViewModel(
      control: control, media: media,
      refreshConversation: { conversation.refreshReconnectDisplay() },
      interruptConversation: {
        conversation.interruptForPlatform(handedInputIds: $0, afterLocalStop: $1)
      },
      accepted: { conversation.acceptVoiceReceipt($0) })
    let model = try XCTUnwrap(voice)
    await conversation.start()
    model.start()
    try await eventually("Voice listening") { model.state.capture == .listening }
    let owner = model.state.origin
    let text = String(repeating: "Synthetic vocabulary learning context. ", count: 150)
    conversation.editDraft(text)
    await conversation.send()
    let input = try XCTUnwrap(conversation.messages.first { $0.role == .user })
    XCTAssertEqual(input.text, text)
    try await eventually("actual output playing") { model.output.current?.status == .playing }
    let identity = try XCTUnwrap(model.output.current?.identity)
    let preparationCount = media.prepared.count
    let readyCount = await control.readyCount
    XCTAssertEqual(preparationCount, 1)
    XCTAssertEqual(readyCount, 1)
    try await eventually("reply observer disconnected") { await transport.disconnected }
    try await eventually("read-only reply recovery waiting") { await transport.recoveryWaiting }
    await control.block()
    try await eventually("Voice observation blocked before HTTP") { await control.waiting }
    let stops = media.stops
    model.speechStarted()
    XCTAssertTrue(
      model.output.locallyInterrupted, "Local suppression is synchronous, before acknowledgement")
    XCTAssertGreaterThan(media.stops, stops)
    try await eventually("server interrupt committed and response lost") {
      await control.interrupted
    }
    XCTAssertEqual(model.state.origin, owner)
    XCTAssertEqual(model.state.capture, .listening)
    XCTAssertEqual(model.output.current?.identity, identity)
    let pending = try await facts(controlOrigin, before: input.recordId + 1, session: session)
    XCTAssertEqual(pending.answerCalls, 1)
    XCTAssertGreaterThan(pending.summaryCalls, 0)
    XCTAssertEqual(pending.snapshot.state, "pending")
    await control.release()
    try await eventually("canonical terminal via production snapshot") {
      model.output.current?.status == .interrupted
    }
    XCTAssertEqual(model.output.current?.identity, identity)
    XCTAssertEqual(model.state.origin, owner)
    XCTAssertTrue(model.output.locallyInterrupted)
    XCTAssertEqual(media.prepared.count, preparationCount)
    let finalReady = await control.readyCount
    XCTAssertEqual(finalReady, readyCount)
    await transport.release()
    try await eventually("durable interrupted receipt via read-only recovery") {
      conversation.messages.contains {
        $0.role == .assistant && $0.responseId == identity.responseId
      }
    }
    let receipt = try XCTUnwrap(conversation.messages.first { $0.role == .assistant })
    XCTAssertEqual(receipt.inputDeliveryId, input.deliveryId)
    XCTAssertEqual(receipt.outcome, .interrupted)
    XCTAssertNil(conversation.replyObservationFailure)
    let sends = await transport.sends
    let retries = await transport.retries
    let reads = await transport.reads
    XCTAssertEqual(sends, 1)
    XCTAssertEqual(retries, 0)
    XCTAssertGreaterThan(reads, 0)
    let reopened = ConversationViewModel(
      transport: realConversation, draftStore: MemoryDraftStore())
    await reopened.start()
    await reopened.loadHistory()
    XCTAssertEqual(reopened.messages.filter { $0.deliveryId == input.deliveryId }, [input])
    XCTAssertEqual(reopened.messages.filter { $0.responseId == identity.responseId }, [receipt])
    let stillPending = try await facts(controlOrigin, before: receipt.recordId, session: session)
    XCTAssertEqual(stillPending.answerCalls, 1)
    XCTAssertEqual(stillPending.snapshot.state, "pending")
    var release = URLRequest(url: controlOrigin.appendingPathComponent("release-summaries"))
    release.httpMethod = "POST"
    let (_, response) = try await session.data(for: release)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    try await eventually("independent real unii summary completion") {
      try await self.facts(controlOrigin, before: receipt.recordId, session: session).snapshot.state
        == "ready"
    }
    let complete = try await facts(controlOrigin, before: receipt.recordId, session: session)
    XCTAssertEqual(complete.answerCalls, 1)
    XCTAssertTrue(complete.snapshot.text?.contains("Retained synthetic learning memory.") == true)
    await reopened.shutdown()
    await conversation.shutdown()
    await model.shutdown()
    print("CONVERGENCE_BOUNDARY_PASSED")
  }

  private struct Facts: Decodable {
    let answerCalls: Int
    let summaryCalls: Int
    let snapshot: Snapshot
    struct Snapshot: Decodable {
      let state: String
      let text: String?
    }
  }
  private func facts(_ origin: URL, before: Int, session: URLSession) async throws -> Facts {
    var components = try XCTUnwrap(
      URLComponents(url: origin.appendingPathComponent("facts"), resolvingAgainstBaseURL: false))
    components.queryItems = [URLQueryItem(name: "before", value: String(before))]
    let (data, response) = try await session.data(from: try XCTUnwrap(components.url))
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    return try JSONDecoder().decode(Facts.self, from: data)
  }
  private func eventually(_ description: String, _ predicate: () async throws -> Bool) async throws
  {
    let deadline = ContinuousClock.now + .seconds(12)
    while try await !predicate() {
      if ContinuousClock.now >= deadline {
        XCTFail("Timed out: \(description)")
        throw BoundaryTimeout()
      }
      try await Task.sleep(for: .milliseconds(20))
    }
  }
  private struct BoundaryTimeout: Error {}
}
