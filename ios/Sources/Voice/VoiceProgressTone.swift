import Foundation

/// Bounded PCM envelope; the media adapter supplies the monotonic clock and device format.
internal struct VoiceProgressTone {
  private var samples: [Float] = []
  private var position = 0
  private var expiresAt = 0.0
  private var lastStarted = -Double.infinity
  private var stopping = false
  private var fadeRemaining = 0
  private var fadeFrames = 1

  mutating func play(_ cue: VoiceProgressCue, now: Double, sampleRate: Int) {
    guard sampleRate >= 8000, sampleRate <= 192000 else { return }
    if cue == .textReady, now - lastStarted < 0.3 { return }
    if cue == .generationStarted { lastStarted = now }
    let duration = cue == .generationStarted ? 0.12 : 0.09
    let count = Int(Double(sampleRate) * duration)
    samples = (0..<count).map { index in
      let time = Double(index) / Double(sampleRate)
      let progress = time / duration
      let start = cue == .generationStarted ? 520.0 : 740.0
      let end = cue == .generationStarted ? 740.0 : 520.0
      let phase = 2 * Double.pi * (start * time + (end - start) * time * time / (2 * duration))
      let envelope = min(1, time / 0.008) * min(1, (duration - time) / 0.012)
      return Float(sin(phase) * envelope * 0.035 * (0.9 + 0.1 * progress))
    }
    position = 0
    expiresAt = now + 0.5
    stopping = false
    fadeFrames = max(1, sampleRate / 200)
  }

  mutating func cancel() {
    guard !stopping else { return }
    stopping = true
    fadeRemaining = fadeFrames
  }

  mutating func next(now: Double) -> Float {
    guard now <= expiresAt, position < samples.count else { return 0 }
    if stopping, fadeRemaining == 0 { return 0 }
    var sample = samples[position]
    position += 1
    if stopping {
      sample *= Float(fadeRemaining) / Float(fadeFrames)
      fadeRemaining -= 1
    }
    return sample
  }
}
