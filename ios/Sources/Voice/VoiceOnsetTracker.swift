import Foundation

internal struct VoiceOnsetNotice: Sendable {
  fileprivate let epoch: UUID
}

/// Native barge-in qualification only. It does not recognize speech or decide
/// whether a finalized utterance is accepted by the conversation.
internal struct VoiceOnsetTracker: Sendable {
  private static let peakThreshold: Float = 0.025
  private static let onsetSeconds = 0.060
  // Preserve the native gate's former 20 × 10ms quiet rearm. The backend's
  // separate recognition-segment quiet boundary remains 400ms.
  private static let rearmSeconds = 0.200
  private var epoch: UUID
  init(epoch: UUID = UUID()) { self.epoch = epoch }
  mutating func reset(epoch: UUID) { self = Self(epoch: epoch) }
  func isCurrent(_ notice: VoiceOnsetNotice) -> Bool { notice.epoch == epoch }
  private var speaking = false
  private var voicedSeconds = 0.0
  private var quietSeconds = 0.0

  mutating func process(peak: Float, frameCount: Int, sampleRate: Double) -> VoiceOnsetNotice? {
    guard peak.isFinite, frameCount > 0, sampleRate.isFinite, sampleRate > 0 else {
      voicedSeconds = 0
      return nil
    }
    let duration = Double(frameCount) / sampleRate
    guard duration.isFinite else {
      voicedSeconds = 0
      return nil
    }
    if peak < Self.peakThreshold {
      voicedSeconds = 0
      if speaking {
        quietSeconds = min(Self.rearmSeconds, quietSeconds + duration)
        if Self.reached(quietSeconds, Self.rearmSeconds) { speaking = false }
      }
      return nil
    }
    quietSeconds = 0
    guard !speaking else { return nil }
    voicedSeconds = min(Self.onsetSeconds, voicedSeconds + duration)
    guard Self.reached(voicedSeconds, Self.onsetSeconds) else { return nil }
    speaking = true
    return VoiceOnsetNotice(epoch: epoch)
  }

  private static func reached(_ elapsed: Double, _ boundary: Double) -> Bool {
    // Sample/rate conversions can land a few floating-point ulps below an
    // exact boundary. This tolerance is far smaller than one audio sample.
    elapsed >= boundary || boundary - elapsed <= boundary.ulp * 8
  }
}
