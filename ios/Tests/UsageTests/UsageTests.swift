import Foundation
import XCTest
@testable import Usage

@MainActor final class UsageTests: XCTestCase {
  func testStaleRefreshCannotOverwriteNewerDataAndFailureKeepsSnapshot() throws {
    let first = transitionUsage(UsageState(), .refresh)
    let second = transitionUsage(first, .refresh)
    let value = try fixture()
    XCTAssertEqual(transitionUsage(second, .loaded(1, .success(value))), second)
    let loaded = transitionUsage(second, .loaded(2, .success(value)))
    XCTAssertEqual(loaded.snapshot, value)
    let refreshing = transitionUsage(loaded, .refresh)
    let failed = transitionUsage(refreshing, .loaded(3, .failure(.connection)))
    XCTAssertEqual(failed.snapshot, value)
    XCTAssertEqual(failed.failure, .connection)
    XCTAssertFalse(failed.loading)
    XCTAssertEqual(transitionUsage(failed, .cancelled(1)), failed)
    XCTAssertFalse(transitionUsage(refreshing, .cancelled(3)).loading)
  }
  func testMissingTokensStayNilAndReportedZeroIsPreserved() throws {
    let snapshot = try fixture()
    XCTAssertTrue(snapshot.isValid)
    XCTAssertNil(snapshot.ledger.totals.first?.cachedInput)
    XCTAssertEqual(snapshot.ledger.totals.first?.input, 0)
    let negative = try fixture(input: "-1")
    XCTAssertFalse(negative.isValid)
    let overflowingCache = try fixture(cached: "2")
    XCTAssertTrue(overflowingCache.isValid, "Partial aggregates can cover different request subsets")
    let invalidRequest = try JSONDecoder().decode(UsageTokens.self, from: Data("{\"input\":0,\"cachedInput\":2}".utf8))
    XCTAssertFalse(invalidRequest.isValid)
    XCTAssertEqual(snapshot.speech.models.first?.costUSD, "0.1273980000")
  }
  func testBillingFailureRetainsPriorValuesOnlyForTheSameProviderScope() throws {
    let first = try fixture()
    let loaded = transitionUsage(transitionUsage(UsageState(), .refresh), .loaded(1, .success(first)))
    let pending = transitionUsage(loaded, .refresh)
    let offline = try fixture(status: "unavailable", models: "[]")
    let retained = transitionUsage(pending, .loaded(2, .success(offline)))
    XCTAssertEqual(retained.snapshot?.speech.models, first.speech.models)
    XCTAssertEqual(retained.snapshot?.speech.status, "unavailable")
    let otherProject = try fixture(scope: "other-project", status: "permission", models: "[]")
    let changed = transitionUsage(pending, .loaded(2, .success(otherProject)))
    XCTAssertTrue(changed.snapshot?.speech.models.isEmpty == true)
  }
  func testViewModelProjectsTypedFailureAndRecoversWithoutLosingRecordedUsage() async throws {
    let client = FixtureUsageClient(value: try fixture())
    let model = UsageViewModel(client: client)
    await model.refresh()
    let original = model.state.snapshot
    client.failure = .authentication
    await model.refresh()
    XCTAssertEqual(model.state.snapshot, original)
    XCTAssertEqual(model.state.failure, .authentication)
    client.failure = nil
    await model.refresh()
    XCTAssertNil(model.state.failure)
    XCTAssertFalse(model.state.loading)
  }
}

private func fixture(input: String = "0", cached: String = "null", scope: String = "project",
  status: String = "available", models: String? = nil) throws -> UsageSnapshot {
  let reported = models ?? """
    [{"model":"tts-rt-v2","total_api_cost_usd":"0.1273980000","total_num_requests":194,
      "total_input_text_tokens":2,"total_input_audio_tokens":0,"total_output_text_tokens":0,
      "total_output_audio_tokens":3,"total_input_audio_duration_ms":0,"total_output_audio_duration_ms":622098}]
    """
  return try JSONDecoder().decode(UsageSnapshot.self, from: Data("""
    {"ledger":{"since":1000,"degraded":false,"recent":[],"totals":[
      {"category":"chat","model":"gpt-6.1-sol","attempts":1,"unreported":1,
       "input":\(input),"cachedInput":\(cached),"output":0,"reasoningOutput":null}]},
     "speech":{"scope":"\(scope)","status":"\(status)","startTime":"2026-09-18T00:00:00Z",
       "endTime":"2026-10-18T00:00:00Z","fetchedAt":1000,"models":\(reported)}}
    """.utf8))
}
@MainActor private final class FixtureUsageClient: UsageClient {
  let value: UsageSnapshot
  var failure: UsageFailure?
  init(value: UsageSnapshot) { self.value = value }
  func load() async throws -> UsageSnapshot {
    if let failure { throw failure }
    return value
  }
}
