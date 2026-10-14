import Foundation
import XCTest

@testable import Voice

@MainActor final class VoiceHTTPTests: XCTestCase {
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
