import XCTest

@testable import Voice

@MainActor final class VoiceAdmissionCheckpointTests: XCTestCase {
  func testRestartRestoresExactBoundedAssociationsAndCannotResolveAgainstAnotherOrigin()
    async throws
  {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let first = try XCTUnwrap(URL(string: "https://example.test:8444"))
    let second = try XCTUnwrap(URL(string: "https://other.test:8444"))
    let file = try FileVoiceAdmissionCheckpoint.fileURL(in: directory, controlOrigin: first)
    let records = [
      VoiceAdmissionAssociation(
        backendIncarnationId: UUID(), sessionId: UUID(), deliveryId: UUID(), detectedLanguage: "ru"),
      VoiceAdmissionAssociation(
        backendIncarnationId: UUID(), sessionId: UUID(), deliveryId: UUID()),
    ]
    let checkpoint = try FileVoiceAdmissionCheckpoint(url: file, controlOrigin: first)
    try await checkpoint.save(records)
    let restarted = try FileVoiceAdmissionCheckpoint(url: file, controlOrigin: first)
    let restored = try await restarted.load()
    XCTAssertEqual(restored, records)
    let wrongOrigin = try FileVoiceAdmissionCheckpoint(url: file, controlOrigin: second)
    do {
      _ = try await wrongOrigin.load()
      XCTFail("Unresolved associations crossed origins")
    } catch { XCTAssertEqual(error as? VoiceFailure, .checkpointUnavailable) }
    try await checkpoint.save([])
    let empty = try await wrongOrigin.load()
    XCTAssertTrue(empty.isEmpty)
    XCTAssertNotEqual(
      file, try FileVoiceAdmissionCheckpoint.fileURL(in: directory, controlOrigin: second))
  }
  func testOversizedCheckpointAndThirdAssociationFailWithoutReplacingKnownRecords() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let origin = try XCTUnwrap(URL(string: "http://example.test"))
    let file = try FileVoiceAdmissionCheckpoint.fileURL(in: directory, controlOrigin: origin)
    let record = VoiceAdmissionAssociation(
      backendIncarnationId: UUID(), sessionId: UUID(), deliveryId: UUID())
    let checkpoint = try FileVoiceAdmissionCheckpoint(url: file, controlOrigin: origin)
    try await checkpoint.save([record])
    do {
      try await checkpoint.save([record, record, record])
      XCTFail("Capacity overflow accepted")
    } catch { XCTAssertEqual(error as? VoiceFailure, .invalidResponse) }
    let preserved = try await checkpoint.load()
    XCTAssertEqual(preserved, [record])
    try Data(repeating: 32, count: 4097).write(to: file)
    do {
      _ = try await checkpoint.load()
      XCTFail("Oversized checkpoint accepted")
    } catch { XCTAssertEqual(error as? VoiceFailure, .checkpointUnavailable) }
  }
}
