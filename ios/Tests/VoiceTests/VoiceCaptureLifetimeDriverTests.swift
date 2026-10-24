import XCTest
@testable import Voice

/// Mirrors pinned WebRTC ba469aa: persistent initialization does not set
/// input_running, and a Room's StopRecording clears that global running flag.
@MainActor final class VendorCaptureDevice: VoiceCaptureDevice {
  var prepared = false
  var inputRunning = false
  var microphoneMuted = true
  var calls: [String] = []
  var holdPreparation = false
  var preparationWaiting = false
  private var gate: CheckedContinuation<Void, Never>?
  func resolvePreparation() { holdPreparation = false; gate?.resume(); gate = nil }
  var startFailure: VoiceFailure?
  var stopFailure: VoiceFailure?
  var prepareFailure: VoiceFailure?
  func prepare(_ enabled: Bool) async throws {
    calls.append(enabled ? "prepare" : "releasePreparation")
    if enabled && holdPreparation {
      preparationWaiting = true
      await withCheckedContinuation { gate = $0 }
    }
    if let prepareFailure { throw prepareFailure }
    prepared = enabled
  }
  func startRecording() async throws {
    calls.append("startRecording")
    if let startFailure { throw startFailure }
    inputRunning = true
    microphoneMuted = false
  }
  func stopRecording() async throws {
    calls.append("stopRecording")
    if let stopFailure { throw stopFailure }
    inputRunning = false
  }
  func snapshot() async -> VoiceCaptureDeviceSnapshot {
    VoiceCaptureDeviceSnapshot(prepared: prepared, engineRunning: inputRunning, microphoneMuted: microphoneMuted)
  }
  func roomStarted() { inputRunning = true; microphoneMuted = false }
  func roomStopped() { inputRunning = false }
}

@MainActor final class VoiceCaptureLifetimeDriverTests: XCTestCase {
  func testExplicitIntentRestoresActualEngineAfterRoomStopDespitePreparationSurviving() async throws {
    let device = VendorCaptureDevice()
    let driver = VoiceCaptureLifetimeDriver(device: device)
    try await driver.setEnabled(true)
    device.roomStarted()
    device.roomStopped()
    let stopped = await device.snapshot()
    XCTAssertTrue(stopped.prepared)
    XCTAssertFalse(stopped.engineRunning, "Vendor preparation does not keep the engine running")
    try await driver.setEnabled(true)
    let renewed = await device.snapshot()
    XCTAssertTrue(renewed.engineRunning, "Background recovery requires actual SDK recording, not initialization")
    XCTAssertFalse(renewed.microphoneMuted)
  }
  func testCleanupAttemptsBothSDKStepsAndDoesNotReportSuccessWhenEitherFails() async throws {
    for stopFails in [false, true] {
      let device = VendorCaptureDevice()
      let driver = VoiceCaptureLifetimeDriver(device: device)
      try await driver.setEnabled(true)
      device.calls = []
      if stopFails { device.stopFailure = .capture } else { device.prepareFailure = .capture }
      do {
        try await driver.setEnabled(false)
        XCTFail("An incomplete SDK release must remain failed")
      } catch { XCTAssertEqual(error as? VoiceFailure, .capture) }
      XCTAssertEqual(device.calls, ["stopRecording", "releasePreparation"])
      XCTAssertEqual(device.inputRunning, stopFails)
      XCTAssertEqual(device.prepared, !stopFails)
    }
  }

}
