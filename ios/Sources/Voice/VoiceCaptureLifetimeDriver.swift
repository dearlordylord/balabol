import Foundation

/// Scalar SDK readback; preparation and actual engine execution are distinct.
internal struct VoiceCaptureDeviceSnapshot: Codable, Equatable, Sendable {
  let prepared: Bool
  let engineRunning: Bool
  let microphoneMuted: Bool
}

/// Exact SDK device operations, independent of a Room or platform framework.
@MainActor internal protocol VoiceCaptureDevice: AnyObject {
  func prepare(_ enabled: Bool) async throws
  func startRecording() async throws
  func stopRecording() async throws
  func snapshot() async -> VoiceCaptureDeviceSnapshot
}

/// Binding for one explicit microphone intent. The feature's serialized lane
/// fences calls; this driver owns neither retry policy nor a second intent.
@MainActor internal struct VoiceCaptureLifetimeDriver {
  let device: any VoiceCaptureDevice
  func setEnabled(_ enabled: Bool) async throws {
    if enabled {
      try Task.checkCancellation()
      try await device.prepare(true)
      // A revoked acquisition may finish noncooperatively. Do not unmute/start
      // recording after that fence; the lane still compensates its preparation.
      try Task.checkCancellation()
      try await device.startRecording()
      return
    }
    // Neither failing cleanup step may prevent the other from being attempted.
    // The lifetime owner retains uncertainty until the complete release succeeds.
    var firstFailure: (any Error)?
    do { try await device.stopRecording() } catch { firstFailure = error }
    do { try await device.prepare(false) } catch { if firstFailure == nil { firstFailure = error } }
    if let firstFailure { throw firstFailure }
  }
}
