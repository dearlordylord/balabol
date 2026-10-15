import Foundation

internal struct VoiceOnsetNotice: Sendable {
  fileprivate let epoch: UUID
}

/// Native barge-in qualification only. It does not recognize speech or decide
/// whether a finalized utterance is accepted by the conversation.
internal struct VoiceOnsetTracker: Sendable {
  static let rmsThreshold: Float = 0.006
  private static let onsetSeconds = 0.060
  // Preserve the native gate's former 20 × 10ms quiet rearm. The backend's
  // separate recognition endpoint deliberately waits longer.
  private static let rearmSeconds = 0.200
  private var epoch: UUID
  init(epoch: UUID = UUID()) { self.epoch = epoch }
  mutating func reset(epoch: UUID) { self = Self(epoch: epoch) }
  func isCurrent(_ notice: VoiceOnsetNotice) -> Bool { notice.epoch == epoch }
  private var speaking = false
  private var voicedSeconds = 0.0
  private var quietSeconds = 0.0

  private var windowFrames = 0
  private var windowSquares = 0.0
  private var windowRate = 0.0
  private var windowChannels = 0

  // Fixed sample windows survive callback boundaries. A brief transient cannot
  // borrow the duration of a larger SDK buffer to qualify sustained onset.
  mutating func processCapture(
    frameCount: Int, channelCount: Int, sampleRate: Double,
    sample: (_ frame: Int, _ channel: Int) -> Float
  ) -> (energy: VoiceCaptureEnergy, onset: VoiceOnsetNotice?)? {
    guard frameCount > 0, (1...2).contains(channelCount), sampleRate.isFinite,
      sampleRate >= 100, sampleRate <= 192000
    else { return nil }
    if windowRate != sampleRate || windowChannels != channelCount {
      windowFrames = 0
      windowSquares = 0
      voicedSeconds = 0
      windowRate = sampleRate
      windowChannels = channelCount
    }
    let targetFrames = Int((sampleRate / 100).rounded(.up))
    var onset: VoiceOnsetNotice?
    var squares = 0.0
    var peak: Float = 0
    for frame in 0..<frameCount {
      for channel in 0..<channelCount {
        let value = sample(frame, channel)
        guard value.isFinite, abs(value) <= 1 else {
          windowFrames = 0
          windowSquares = 0
          voicedSeconds = 0
          return nil
        }
        let square = Double(value) * Double(value)
        squares += square
        windowSquares += square
        peak = max(peak, abs(value))
      }
      windowFrames += 1
      if windowFrames == targetFrames {
        let rms = Float(sqrt(windowSquares / Double(windowFrames) / Double(channelCount)))
        if let notice = process(rms: rms, frameCount: windowFrames, sampleRate: sampleRate) {
          onset = notice
        }
        windowFrames = 0
        windowSquares = 0
      }
    }
    let energy = VoiceCaptureEnergy(
      rms: Float(sqrt(squares / Double(frameCount) / Double(channelCount))), peak: peak)
    return (energy, onset)
  }

  mutating func process(rms: Float, frameCount: Int, sampleRate: Double) -> VoiceOnsetNotice? {
    guard rms.isFinite, rms >= 0, rms <= 1, frameCount > 0, sampleRate.isFinite, sampleRate > 0
    else {
      voicedSeconds = 0
      return nil
    }
    let duration = Double(frameCount) / sampleRate
    guard duration.isFinite else {
      voicedSeconds = 0
      return nil
    }
    if rms < Self.rmsThreshold {
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

/// Shared by native buffer traversal and deterministic capture fixtures.
/// RMS rejects sparse peaks; sustained noise above the threshold can still qualify.
internal struct VoiceCaptureEnergy {
  let rms: Float
  let peak: Float

}
