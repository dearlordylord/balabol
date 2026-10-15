@preconcurrency import AVFoundation
import Foundation

internal struct VoiceOnsetNotice: Sendable {
  let epoch: UUID
}

internal enum VoiceActivityError: Error, Equatable {
  case invalidFrame, invalidProbability, modelUnavailable, inference, overflow
}
internal protocol VoiceActivityClassifier: Sendable {
  func probability(_ frame: [Float]) async throws -> Float
  func reset() async
}
internal struct VoiceActivityDecision {
  private var speechFrames = 0
  private var quietFrames = 0
  private var speaking = false
  mutating func accept(_ probability: Float) throws -> Bool {
    guard probability.isFinite, (0...1).contains(probability) else {
      throw VoiceActivityError.invalidProbability
    }
    if probability < 0.5 {
      speechFrames = 0
      quietFrames += 512
      if quietFrames >= 3200 { speaking = false }
      return false
    }
    quietFrames = 0
    guard !speaking else { return false }
    speechFrames += 512
    guard speechFrames >= 1024 else { return false }
    speaking = true
    return true
  }
}

// This converter is confined to the single inference worker. It never owns an
// audio engine/session, and .noDataNow preserves filter history across callbacks.
internal struct VoiceActivityFramer {
  private var rate = 0.0
  private var converter: AVAudioConverter?
  private var input: AVAudioPCMBuffer?
  private var output: AVAudioPCMBuffer?
  private var frame = [Float](repeating: 0, count: 512)
  private var filled = 0

  mutating func append(_ samples: UnsafeBufferPointer<Float>, sampleRate: Double) throws
    -> [[Float]]
  {
    guard sampleRate.isFinite, (8000...192000).contains(sampleRate), !samples.isEmpty,
      samples.count <= 8192,
      samples.allSatisfy({ $0.isFinite && abs($0) <= 1 })
    else { throw VoiceActivityError.invalidFrame }
    if rate != sampleRate {
      self = Self()
      rate = sampleRate
      if sampleRate != 16000 {
        guard
          let source = AVAudioFormat(
            commonFormat: .pcmFormatFloat32, sampleRate: sampleRate,
            channels: 1, interleaved: false),
          let target = AVAudioFormat(
            commonFormat: .pcmFormatFloat32, sampleRate: 16000,
            channels: 1, interleaved: false),
          let converter = AVAudioConverter(from: source, to: target),
          let input = AVAudioPCMBuffer(pcmFormat: source, frameCapacity: 8192),
          let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: 17408)
        else { throw VoiceActivityError.invalidFrame }
        converter.sampleRateConverterQuality = AVAudioQuality.max.rawValue
        converter.primeMethod = .none
        self.converter = converter
        self.input = input
        self.output = output
      }
    }
    if sampleRate == 16000 { return collect(samples) }
    guard let converter, let input, let output, let source = input.floatChannelData?[0],
      let destination = output.floatChannelData?[0]
    else { throw VoiceActivityError.invalidFrame }
    guard let base = samples.baseAddress else { throw VoiceActivityError.invalidFrame }
    output.frameLength = 0
    var supplied = 0
    var error: NSError?
    let status = converter.convert(to: output, error: &error) { requested, inputStatus in
      guard supplied < samples.count else {
        inputStatus.pointee = .noDataNow
        return nil
      }
      let count = min(Int(requested), samples.count - supplied)
      source.update(from: base.advanced(by: supplied), count: count)
      input.frameLength = AVAudioFrameCount(count)
      supplied += count
      inputStatus.pointee = .haveData
      return input
    }
    guard status != .error, error == nil, status != .endOfStream, supplied == samples.count else {
      throw VoiceActivityError.inference
    }
    return collect(UnsafeBufferPointer(start: destination, count: Int(output.frameLength)))
  }
  private mutating func collect(_ samples: UnsafeBufferPointer<Float>) -> [[Float]] {
    var result: [[Float]] = []
    for sample in samples {
      frame[filled] = sample
      filled += 1
      if filled == 512 {
        result.append(frame)
        filled = 0
      }
    }
    return result
  }
}
