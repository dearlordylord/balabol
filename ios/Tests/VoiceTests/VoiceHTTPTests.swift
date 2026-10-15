import Foundation
import XCTest
import os

@testable import Voice

@MainActor final class VoiceHTTPTests: XCTestCase {
  func testSealWithoutSuccessfulJoinCannotInferProducerClosure() async throws {
    let session = URLSession(configuration: .ephemeral)
    defer { session.invalidateAndCancel() }
    let control = try HTTPVoiceControl(
      baseURL: XCTUnwrap(URL(string: "http://127.0.0.1:1")), session: session)
    do {
      _ = try await control.seal(sessionId: UUID())
      XCTFail("Unjoined scope cannot establish producer closure")
    } catch {
      XCTAssertEqual(error as? VoiceFailure, .invalidResponse)
    }
  }
  func testExpiredDeadlineCheckpointRetainsKnownJoinAuthorityUntilSealed() async throws {
    guard let endpoint = ProcessInfo.processInfo.environment["BALABOL_TEST_VOICE_SERVER"],
      let url = URL(string: endpoint)
    else { throw XCTSkip("Set BALABOL_TEST_VOICE_SERVER to an isolated LiveKit backend.") }
    let session = URLSession(configuration: .ephemeral)
    defer { session.invalidateAndCancel() }
    let control = try HTTPVoiceControl(baseURL: url, session: session)
    let join = try await control.start(requestId: UUID(), muted: true)
    let remaining = join.controlDeadlineAt - Date().timeIntervalSince1970 * 1000
    guard remaining >= 0, remaining <= 35_000 else {
      XCTFail("Expected bounded prototype control lease")
      try? await control.end(sessionId: join.sessionId)
      return
    }
    // The public checkpoint retention operation used to erase even the current
    // successful Join after its lease expired. Deadline is not closure evidence.
    try await Task.sleep(for: .milliseconds(Int(remaining) + 150))
    await control.retain(admissions: [])
    switch try await control.seal(sessionId: join.sessionId) {
    case .ended(let page):
      XCTAssertEqual(page.status, "ended")
      XCTAssertEqual(page.sessionId, join.sessionId)
      XCTAssertEqual(page.backendIncarnationId, join.backendIncarnationId)
    case .producerUnavailable(let sessionId, let incarnation):
      XCTAssertEqual(sessionId, join.sessionId)
      XCTAssertEqual(incarnation, join.backendIncarnationId)
    }
  }
  func testRealBootstrapCapabilityAuthorizesOnlyItsSession() async throws {
    guard let endpoint = ProcessInfo.processInfo.environment["BALABOL_TEST_VOICE_SERVER"],
      let url = URL(string: endpoint)
    else { throw XCTSkip("Set BALABOL_TEST_VOICE_SERVER to an isolated LiveKit backend.") }
    let session = URLSession(configuration: .ephemeral)
    defer { session.invalidateAndCancel() }
    let control = try HTTPVoiceControl(baseURL: url, session: session)
    let join = try await control.start()
    XCTAssertNotEqual(URL(string: join.mediaUrl)?.port, url.port)
    let active = try await control.snapshot(sessionId: join.sessionId, after: 0)
    XCTAssertEqual(active.status, "active")
    var unauthorized = URLRequest(
      url: url.appendingPathComponent("voice/sessions/" + join.sessionId.uuidString))
    unauthorized.timeoutInterval = 5
    let (_, response) = try await session.data(for: unauthorized)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 401)
    try await control.mute(sessionId: join.sessionId, muted: true)
    let muted = try await control.snapshot(sessionId: join.sessionId, after: active.sequence)
    XCTAssertTrue(muted.muted)
    XCTAssertTrue(muted.events.contains { $0.kind == "Muted" && $0.muted == true })
    try await control.end(sessionId: join.sessionId)
    let ended = try await control.snapshot(sessionId: join.sessionId, after: muted.sequence)
    XCTAssertEqual(ended.status, "ended")
    XCTAssertTrue(ended.events.contains { $0.kind == "Ended" })
  }
  func testUncertainBootstrapIdentityAndRestartResolutionContract() async throws {
    guard let endpoint = ProcessInfo.processInfo.environment["BALABOL_TEST_VOICE_SERVER"],
      let url = URL(string: endpoint)
    else { throw XCTSkip("Set BALABOL_TEST_VOICE_SERVER to an isolated LiveKit backend.") }
    let session = URLSession(configuration: .ephemeral)
    defer { session.invalidateAndCancel() }
    let control = try HTTPVoiceControl(baseURL: url, session: session)
    let request = UUID()
    let join = try await control.start(requestId: request, muted: true)
    let retried = try await control.start(requestId: request, muted: true)
    XCTAssertEqual(join.sessionId, retried.sessionId)
    XCTAssertEqual(join.startRequestId, request)
    XCTAssertEqual(join.backendIncarnationId, retried.backendIncarnationId)
    XCTAssertTrue(join.token == retried.token, "Retry must retain the original scoped media token")
    XCTAssertTrue(join.controlToken == retried.controlToken, "Retry must retain its capability")
    XCTAssertEqual(join.joinDeadlineAt, retried.joinDeadlineAt)
    let snapshot = try await control.snapshot(sessionId: join.sessionId, after: 0)
    XCTAssertTrue(snapshot.muted)
    XCTAssertEqual(snapshot.backendIncarnationId, join.backendIncarnationId)
    XCTAssertGreaterThanOrEqual(snapshot.controlDeadlineAt, join.controlDeadlineAt)
    let unknown = VoiceAdmissionAssociation(
      backendIncarnationId: UUID(), sessionId: UUID(), deliveryId: UUID())
    let resolution = try await control.resolve(admissions: [unknown])
    XCTAssertTrue(resolution.isValid(for: [unknown]))
    XCTAssertEqual(resolution.admissions.first?.status, .unknown)
    XCTAssertNil(resolution.admissions.first?.receipt)
    try await control.end(sessionId: join.sessionId)
    do {
      _ = try await control.start(requestId: request, muted: true)
      XCTFail("Ended bootstrap identity must not create a replacement room")
    } catch let failure as VoiceFailure {
      guard case .backend(let code, _) = failure else {
        return XCTFail("Expected typed StartExpired")
      }
      XCTAssertEqual(code, "StartExpired")
    }
  }

}

// An injected URLSession transport serves captured synthetic wire bytes; the
// production HTTPVoiceControl still owns Join and snapshot decoding/validation.
private final class SnapshotReplayProtocol: URLProtocol, @unchecked Sendable {
  static let replies = OSAllocatedUnfairLock(initialState: [String: [Data]]())
  override class func canInit(with request: URLRequest) -> Bool {
    request.url?.host?.hasSuffix(".snapshot.invalid") == true
  }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    guard let url = request.url, let host = url.host else { return }
    let data = Self.replies.withLock { values -> Data? in
      guard var remaining = values[host], !remaining.isEmpty else { return nil }
      let first = remaining.removeFirst()
      values[host] = remaining
      return first
    }
    guard let data,
      let response = HTTPURLResponse(
        url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)
    else {
      client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
      return
    }
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: data)
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}

extension VoiceHTTPTests {
  func testCapturedSyntheticBackendSnapshotsThroughProductionHTTPDecoder() async throws {
    guard let path = ProcessInfo.processInfo.environment["BALABOL_TEST_VOICE_SNAPSHOTS"] else {
      throw XCTSkip("Set BALABOL_TEST_VOICE_SNAPSHOTS to synthetic backend wire evidence.")
    }
    let file = try FileHandle(forReadingFrom: URL(fileURLWithPath: path))
    defer { try? file.close() }
    let data = try file.read(upToCount: 2_097_153) ?? Data()
    XCTAssertLessThanOrEqual(data.count, 2_097_152)
    let envelope = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    var join = try XCTUnwrap(envelope["join"] as? [String: Any])
    let snapshots = try XCTUnwrap(envelope["snapshots"] as? [[String: Any]])
    XCTAssertFalse(snapshots.isEmpty)
    XCTAssertLessThanOrEqual(snapshots.count, 240)
    // Synthetic Join leases keep the offline replay independent of capture time.
    let deadline = Date().timeIntervalSince1970 * 1000 + 60_000
    join["expiresAt"] = deadline
    join["joinDeadlineAt"] = deadline
    join["controlDeadlineAt"] = deadline
    let request = try XCTUnwrap(UUID(uuidString: XCTUnwrap(join["startRequestId"] as? String)))
    let host = UUID().uuidString.lowercased() + ".snapshot.invalid"
    let replies =
      try [JSONSerialization.data(withJSONObject: join)]
      + snapshots.map { try JSONSerialization.data(withJSONObject: XCTUnwrap($0["snapshot"])) }
    SnapshotReplayProtocol.replies.withLock { $0[host] = replies }
    defer { SnapshotReplayProtocol.replies.withLock { $0.removeValue(forKey: host) } }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [SnapshotReplayProtocol.self]
    let session = URLSession(configuration: configuration)
    defer { session.invalidateAndCancel() }
    let control = try HTTPVoiceControl(
      baseURL: XCTUnwrap(URL(string: "http://" + host)), session: session)
    let joined = try await control.start(requestId: request, muted: false)
    for (index, snapshot) in snapshots.enumerated() {
      let stage = try XCTUnwrap(snapshot["stage"] as? String)
      let after = try XCTUnwrap(snapshot["after"] as? Int)
      do {
        _ = try await control.snapshot(sessionId: joined.sessionId, after: after)
      } catch {
        XCTFail(
          "Synthetic snapshot index=\(index) stage=\(stage) failed production validation: \(error is VoiceFailure ? "VoiceFailure" : "Other")"
        )
        throw error
      }
    }
  }
}
