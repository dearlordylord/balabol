import Foundation
import XCTest

@testable import Voice

private final class FailingVoiceProtocol: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool {
    request.url?.host == "voice-diagnostics.invalid"
  }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    client?.urlProtocol(self, didFailWithError: URLError(.timedOut))
  }
  override func stopLoading() {}
}

@MainActor final class VoiceTransportDiagnosticsTests: XCTestCase {
  #if DEBUG
    func testNetworkFailurePersistsSanitizedCauseThroughURLSessionBoundary() async throws {
      let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
        UUID().uuidString)
      let destination = directory.appendingPathComponent("voice.json")
      defer {
        VoiceTransitionTrace.shared.configure(destination: nil)
        VoiceTransitionTrace.shared.flush()
        try? FileManager.default.removeItem(at: directory)
      }
      VoiceTransitionTrace.shared.configure(destination: destination)
      let configuration = URLSessionConfiguration.ephemeral
      configuration.protocolClasses = [FailingVoiceProtocol.self]
      let session = URLSession(configuration: configuration)
      defer { session.invalidateAndCancel() }
      let control = try HTTPVoiceControl(
        baseURL: XCTUnwrap(URL(string: "https://voice-diagnostics.invalid")), session: session)
      do {
        _ = try await control.languages()
        XCTFail("Expected a network failure")
      } catch {
        XCTAssertEqual(error as? VoiceFailure, .connection)
      }
      VoiceTransitionTrace.shared.flush()
      let data = try Data(contentsOf: destination)
      let snapshot = try JSONDecoder().decode(VoiceTraceSnapshot.self, from: data)
      let failure = try XCTUnwrap(snapshot.events.last { $0.status == "voice-http-network" })
      XCTAssertEqual(failure.cause, .transportFailed)
      XCTAssertEqual(failure.networkCode, URLError.timedOut.rawValue)
      XCTAssertEqual(failure.failureKind, "Connection")
      XCTAssertNil(failure.httpStatus)
      XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("voice-diagnostics.invalid"))
    }
  #endif
}
