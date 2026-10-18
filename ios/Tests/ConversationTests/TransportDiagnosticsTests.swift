import Foundation
import XCTest

@testable import Conversation

final class TransportDiagnosticsTests: XCTestCase {
  func testTransportEvidencePreservesBoundaryWithoutPrivateServerError() throws {
    let id = try XCTUnwrap(UUID(uuidString: "00000000-0000-0000-0000-000000000000"))
    let entry = ReplyObservationDiagnostics.makeEntry(
      input: id, stage: "decode",
      failure: .rejected(code: "private-code", message: "private-transcript"),
      httpStatus: 503, networkCode: URLError.timedOut.rawValue)
    XCTAssertEqual(entry.input, "12b9377cbe7e5c94e8a70d9d23929523")
    XCTAssertEqual(entry.stage, "decode")
    XCTAssertEqual(entry.httpStatus, 503)
    XCTAssertEqual(entry.networkCode, -1001)
    XCTAssertEqual(entry.backendCode, "OtherBackendCode")
    let text = String(decoding: try JSONEncoder().encode(entry), as: UTF8.self)
    XCTAssertFalse(text.contains("private-"))
    XCTAssertFalse(text.contains(id.uuidString))
    let known = ReplyObservationDiagnostics.makeEntry(
      input: nil, stage: "request-status",
      failure: .rejected(code: "Unauthorized", message: "private"), httpStatus: 401)
    XCTAssertEqual(known.backendCode, "Unauthorized")
    XCTAssertNil(known.input)
  }
}

/// URLSession's injected protocol boundary supplies synthetic bytes to the real SSE reader.
private final class DiagnosticReplyProtocol: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool {
    request.url?.host?.hasSuffix(".diagnostics.invalid") == true
  }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    guard let url = request.url else { return }
    if url.host?.hasPrefix("network.") == true {
      client?.urlProtocol(self, didFailWithError: URLError(.timedOut))
      return
    }
    let malformedFrame = url.host?.hasPrefix("decode.") == true
    guard
      let response = HTTPURLResponse(
        url: url, statusCode: 200, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": malformedFrame ? "text/event-stream" : "application/json"])
    else { return }
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data("data: {invalid}\n\n".utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}

extension TransportDiagnosticsTests {
  func testSSEBoundaryPersistsDistinctDecodeHeaderAndNetworkCauses() async throws {
    for stage in ["decode", "headers", "network"] {
      let input = UUID()
      let configuration = URLSessionConfiguration.ephemeral
      configuration.protocolClasses = [DiagnosticReplyProtocol.self]
      let session = URLSession(configuration: configuration)
      defer { session.invalidateAndCancel() }
      let transport = try HTTPConversationTransport(
        baseURL: XCTUnwrap(URL(string: "https://\(stage).diagnostics.invalid")), session: session,
        diagnosticsEnabled: true)
      let observation = try await transport.observeReply(for: input)
      defer { observation.cancel() }
      do {
        for try await _ in observation.events {
          XCTFail("Malformed source cannot produce a snapshot")
        }
        XCTFail("Expected source failure")
      } catch {
        XCTAssertEqual(
          error as? ConversationFailure, stage == "network" ? .unavailable : .invalidResponse)
      }
      let hash = ReplyObservationDiagnostics.makeEntry(input: input, stage: "unused").input
      let destination = try FileManager.default.url(
        for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true
      )
      .appendingPathComponent("balabol-reply-observation.json")
      var persisted: ReplyObservationDiagnostics.Entry?
      for _ in 0..<200 {
        if let data = try? Data(contentsOf: destination),
          let entries = try? JSONDecoder().decode(
            [ReplyObservationDiagnostics.Entry].self, from: data)
        {
          persisted = entries.last { $0.input == hash }
        }
        if persisted != nil { break }
        try await Task.sleep(for: .milliseconds(5))
      }
      let entry = try XCTUnwrap(persisted, "Failure must reach the durable journal")
      XCTAssertEqual(entry.stage, stage == "network" ? "headers" : stage)
      XCTAssertEqual(entry.httpStatus, stage == "network" ? nil : 200)
      XCTAssertEqual(entry.networkCode, stage == "network" ? URLError.timedOut.rawValue : nil)
    }
  }
}
