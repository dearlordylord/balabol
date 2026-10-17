import Foundation
import Testing

@testable import Voice

struct VoicePlatformTests {
  @Test func queuedPlatformNotificationCannotCrossCaptureOrObservationLifetime() {
    var epoch = VoicePlatformEpoch()
    let queued = epoch.identity
    #expect(epoch.accepts(queued))
    epoch.advance(to: UUID())
    let muted = epoch.identity
    epoch.advance(to: UUID())
    #expect(!epoch.accepts(queued))
    #expect(!epoch.accepts(muted))
    #expect(epoch.accepts(epoch.identity))
  }
  @Test func onlyExactSchemaValid404SuppliesProducerClosureEvidence() {
    let valid = Data(#"{"error":{"code":"SessionNotFound","message":""}}"#.utf8)
    #expect(HTTPVoiceControl.isProducerClosure(statusCode: 404, data: valid))
    for code in [200, 400, 401, 403, 500, 503] {
      #expect(!HTTPVoiceControl.isProducerClosure(statusCode: code, data: valid))
    }
    let malformed = [
      #"{"error":{"code":"SessionNotFound"}}"#,
      #"{"error":{"code":"SessionNotFound","message":null}}"#,
      #"{"error":{"code":"sessionnotfound","message":"missing"}}"#,
      #"{"error":{"code":"Unavailable","message":"SessionNotFound"}}"#,
      "<html>SessionNotFound</html>",
    ]
    for body in malformed {
      #expect(!HTTPVoiceControl.isProducerClosure(statusCode: 404, data: Data(body.utf8)))
    }
    let oversized = Data(
      (#"{"error":{"code":"SessionNotFound","message":""# + String(repeating: "x", count: 1001)
        + #""}}"#).utf8)
    #expect(!HTTPVoiceControl.isProducerClosure(statusCode: 404, data: oversized))
  }
}
