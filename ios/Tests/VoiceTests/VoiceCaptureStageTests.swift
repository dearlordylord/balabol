import Foundation
import XCTest
@testable import Voice

@MainActor final class VoiceCaptureStageTests: XCTestCase {
  private let locked = VoiceCaptureContext(application: .background, protectedDataAvailable: false)
  func testNativeCaptureCancellationDoesNotBecomeCaptureFailure() async {
    var records: [VoiceCaptureDiagnostic] = []
    do {
      let _: Void = try await performVoiceCaptureStage(.firstFrame, context: { self.locked }, record: { records.append($0) }) {
        throw CancellationError()
      }
      XCTFail("Expected cancellation")
    } catch {
      XCTAssertTrue(error is CancellationError, "Retired capture must remain cancellation")
    }
    XCTAssertEqual(records.map(\.outcome), [.began, .cancelled])
  }
  func testNativeFailureRetainsStageAndSafeCodesWithoutPrivateErrorText() async throws {
    let privateText = "private conversation credential path"
    let underlying = NSError(domain: NSOSStatusErrorDomain, code: 561145187,
      userInfo: [NSLocalizedDescriptionKey: privateText])
    let error = NSError(domain: "io.livekit.swift-sdk", code: 802,
      userInfo: [NSLocalizedDescriptionKey: privateText, NSUnderlyingErrorKey: underlying])
    var records: [VoiceCaptureDiagnostic] = []
    do {
      let _: Void = try await performVoiceCaptureStage(.publication, context: { self.locked }, record: { records.append($0) }) {
        throw error
      }
      XCTFail("Expected capture failure")
    } catch { XCTAssertEqual(error as? VoiceFailure, .capture) }
    let recorded = try XCTUnwrap(records.last)
    XCTAssertEqual(recorded.outcome, .failed)
    XCTAssertEqual(recorded.stage, .publication)
    XCTAssertEqual(recorded.context, locked)
    XCTAssertEqual(recorded.domain, .liveKit)
    XCTAssertEqual(recorded.code, 802)
    XCTAssertEqual(recorded.underlyingDomain, .osStatus)
    XCTAssertEqual(recorded.underlyingCode, 561145187)
    XCTAssertFalse(String(decoding: try JSONEncoder().encode(records), as: UTF8.self).contains(privateText))
  }
  func testSuccessfulCaptureReturnsItsValueAndRecordsTheSamePhase() async throws {
    var records: [VoiceCaptureDiagnostic] = []
    let value = try await performVoiceCaptureStage(.mute, context: { self.locked }, record: { records.append($0) }) { 7 }
    XCTAssertEqual(value, 7)
    XCTAssertEqual(records.map(\.outcome), [.began, .completed])
  }
  #if DEBUG
    func testCaptureFailureIsActuallyPersistedBeforeItBecomesPublicCaptureFailure() async throws {
      let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
      let destination = directory.appendingPathComponent("capture.json")
      defer { try? FileManager.default.removeItem(at: directory) }
      let trace = VoiceTransitionTrace()
      trace.configure(destination: destination)
      do {
        let _: Void = try await performVoiceCaptureStage(.processor, context: { self.locked }, record: {
          trace.record(.nativeCapture, nativeCapture: $0)
        }) {
          throw NSError(domain: NSCocoaErrorDomain, code: 257,
            userInfo: [NSLocalizedDescriptionKey: "private file path and text"])
        }
      } catch { XCTAssertEqual(error as? VoiceFailure, .capture) }
      trace.flush()
      let data = try Data(contentsOf: destination)
      let snapshot = try JSONDecoder().decode(VoiceTraceSnapshot.self, from: data)
      let failure = try XCTUnwrap(snapshot.events.last?.nativeCapture)
      XCTAssertEqual(failure.stage, .processor)
      XCTAssertEqual(failure.context, locked)
      XCTAssertEqual(failure.domain, .cocoa)
      XCTAssertEqual(failure.code, 257)
      XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("private file"))
    }
  #endif
  func testLockDuringNativeOperationIsRecordedAtFailureRatherThanAtStart() async {
    var context = VoiceCaptureContext(application: .active, protectedDataAvailable: true)
    var records: [VoiceCaptureDiagnostic] = []
    do {
      let _: Void = try await performVoiceCaptureStage(.publication, context: { context }, record: { records.append($0) }) {
        context = self.locked
        throw NSError(domain: NSOSStatusErrorDomain, code: 561145187)
      }
    } catch { XCTAssertEqual(error as? VoiceFailure, .capture) }
    XCTAssertEqual(records.first?.context.application, .active)
    XCTAssertEqual(records.last?.context, locked)
  }
  func testUnknownErrorDomainCannotLeakItsDomainOrApplicationCode() throws {
    let value = VoiceCaptureDiagnostic(stage: .processor, context: locked, outcome: .failed,
      error: NSError(domain: "private arbitrary text", code: 12345))
    XCTAssertEqual(value.domain, .other)
    XCTAssertNil(value.code)
    XCTAssertFalse(String(decoding: try JSONEncoder().encode(value), as: UTF8.self).contains("private"))
  }
}
