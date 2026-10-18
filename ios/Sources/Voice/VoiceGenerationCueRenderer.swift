#if os(iOS)
  import Foundation
  import LiveKit
  import os

  /// Mix before WebRTC's reverse-stream processing so the cue shares its echo reference.
  /// No engine, audio-session activation or microphone suppression is introduced.
  internal final class VoiceGenerationCueRenderer: NSObject, AudioCustomProcessingDelegate,
    @unchecked Sendable
  {
    private struct State {
      var sampleRate = 0
      var tone = VoiceProgressTone()
      var pending: (VoiceProgressCue, Double)?
    }
    private let state = OSAllocatedUnfairLock(initialState: State())
    func play(_ cue: VoiceProgressCue) {
      state.withLock { value in
        let now = ProcessInfo.processInfo.systemUptime
        if value.sampleRate == 0 {
          os.Logger(subsystem: "app.balabol.voice", category: "progress-cue")
            .notice("Progress cue waiting for managed playout; expires after 500 ms")
          value.pending = (cue, now)
          return
        }
        value.tone.play(cue, now: now, sampleRate: value.sampleRate)
      }
    }
    func cancel(preservingFailure: Bool = false) {
      state.withLock {
        if !preservingFailure || $0.pending?.0 != .failed { $0.pending = nil }
        $0.tone.cancel(preservingFailure: preservingFailure)
      }
    }
    func audioProcessingInitialize(sampleRate sampleRateHz: Int, channels: Int) {
      state.withLock {
        $0.sampleRate = sampleRateHz
        $0.tone = VoiceProgressTone()
        if let (cue, issued) = $0.pending, ProcessInfo.processInfo.systemUptime - issued < 0.5 {
          $0.tone.play(cue, now: ProcessInfo.processInfo.systemUptime, sampleRate: sampleRateHz)
        } else if $0.pending != nil {
          os.Logger(subsystem: "app.balabol.voice", category: "progress-cue")
            .notice("Progress cue skipped: managed playout became ready after its deadline")
        }
        $0.pending = nil
      }
    }
    func audioProcessingRelease() {
      state.withLock {
        $0.sampleRate = 0
        $0.pending = nil
        $0.tone = VoiceProgressTone()
      }
    }
    func audioProcessingProcess(audioBuffer: LKAudioBuffer) {
      guard audioBuffer.frames > 0, audioBuffer.channels > 0 else { return }
      let now = ProcessInfo.processInfo.systemUptime
      // The SDK's borrowed buffer is consumed synchronously under the lock and never escapes.
      state.withLockUnchecked { value in
        // Remote speech wins immediately; this callback sees the pre-cue buffer.
        let speech = (0..<audioBuffer.channels).contains { channel in
          let samples = audioBuffer.rawBuffer(forChannel: channel)
          return (0..<audioBuffer.frames).contains { abs(samples[$0]) > 3.2768 }
        }
        if speech { value.tone.cancel() }
        for frame in 0..<audioBuffer.frames {
          // WebRTC AudioBuffer float samples use the signed-16-bit amplitude scale.
          let cue = value.tone.next(now: now) * 32768
          for channel in 0..<audioBuffer.channels {
            let samples = audioBuffer.rawBuffer(forChannel: channel)
            samples[frame] = max(-32768, min(32767, samples[frame] + cue))
          }
        }
      }
    }
  }
#endif
