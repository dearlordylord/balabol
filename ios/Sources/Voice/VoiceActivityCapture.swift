import Foundation
import os

// Each slot owns its allocation. A reserved/queued/leased slot has exactly one
// writer or reader; the pool lock transfers ownership, never borrowed SDK PCM.
private final class VoiceCaptureSlot: @unchecked Sendable {
  let samples = UnsafeMutablePointer<Float>.allocate(capacity: 8192)
  var count = 0
  var sampleRate = 0.0
  #if DEBUG
    var capturedAt = 0.0
  #endif
  var epoch = UUID()
  init() { samples.initialize(repeating: 0, count: 8192) }
  deinit {
    samples.deinitialize(count: 8192)
    samples.deallocate()
  }
}
internal final class VoiceActivityCapture: Sendable {
  private struct State {
    var free = Array(0..<8)
    var epoch = UUID()
    var readable = false
    var failed = false
    #if DEBUG
      var failureCode: VoiceActivityError?
    #endif
    var closed = false
    var rate = 0.0
    var channels = 0
  }
  private let state = OSAllocatedUnfairLock(initialState: State())
  private let slots = (0..<8).map { _ in VoiceCaptureSlot() }
  private let continuation: AsyncStream<Int>.Continuation
  private let task: Task<Void, Never>

  init(
    classifier: any VoiceActivityClassifier,
    started: @escaping @Sendable (UUID, Float) -> Void,
    failed: @escaping @Sendable (UUID) -> Void
  ) {
    self.failure = failed
    let stream = AsyncStream<Int>.makeStream(bufferingPolicy: .bufferingNewest(8))
    continuation = stream.continuation
    let state = self.state
    let slots = self.slots
    task = Task.detached(priority: .userInitiated) {
      var current: UUID?
      var format = 0.0
      var framer = VoiceActivityFramer()
      var decision = VoiceActivityDecision()
      for await index in stream.stream {
        guard !Task.isCancelled else { break }
        let slot = slots[index]
        defer { state.withLock { $0.free.append(index) } }
        guard state.withLock({ !$0.closed && !$0.failed && $0.epoch == slot.epoch }) else {
          continue
        }
        if current != slot.epoch || format != slot.sampleRate {
          current = slot.epoch
          format = slot.sampleRate
          framer = VoiceActivityFramer()
          decision = VoiceActivityDecision()
          await classifier.reset()
        }
        do {
          let frames = try framer.append(
            UnsafeBufferPointer(start: slot.samples, count: slot.count), sampleRate: slot.sampleRate
          )
          for frame in frames {
            guard state.withLock({ !$0.closed && !$0.failed && $0.epoch == slot.epoch }),
              !Task.isCancelled
            else { break }
            let probability = try await classifier.probability(frame)
            let onset = try decision.accept(probability)
            if onset && state.withLock({ !$0.closed && !$0.failed && $0.epoch == slot.epoch }) {
              #if DEBUG
                VoiceTransitionTrace.shared.record(
                  .onset, microphone: slot.epoch, capturedAt: slot.capturedAt,
                  classifiedAt: ProcessInfo.processInfo.systemUptime)
              #endif
              started(slot.epoch, probability)
            }
          }
        } catch {
          let epoch = state.withLock { value -> UUID? in
            guard value.epoch == slot.epoch, !value.closed else { return nil }
            value.epoch = UUID()
            value.failed = true
            #if DEBUG
              value.failureCode = (error as? VoiceActivityError) ?? .inference
            #endif
            value.readable = false
            return value.epoch
          }
          if let epoch { failed(epoch) }
        }
      }
    }
  }
  deinit {
    continuation.finish()
    task.cancel()
  }
  var isReadable: Bool { state.withLock { $0.readable } }
  func accepts(_ epoch: UUID) -> Bool {
    state.withLock { $0.epoch == epoch && !$0.failed && !$0.closed }
  }
  func acceptsFailure(_ epoch: UUID) -> Bool {
    state.withLock { $0.epoch == epoch && !$0.closed }
  }
  #if DEBUG
    var failureCode: VoiceActivityError? { state.withLock { $0.failureCode } }
  #endif
  func reset() {
    state.withLock {
      $0.epoch = UUID()
      $0.readable = false
      $0.failed = false
      #if DEBUG
        $0.failureCode = nil
      #endif
    }
  }
  func stop() async {
    close()
    await task.value
  }
  func close() {
    state.withLock {
      $0.epoch = UUID()
      $0.closed = true
      $0.readable = false
    }
    continuation.finish()
    task.cancel()
  }
  private struct Reservation {
    var indices = SIMD8<Int32>(repeating: -1)
    var count = 0
    var epoch: UUID
    var failed = false
  }
  // Reserve the entire callback before copying: no partial continuity, heap
  // allocation, or SDK pointer survives this synchronous callback.
  func capture(
    frameCount: Int, channels: Int, sampleRate: Double,
    sample: (_ frame: Int, _ channel: Int) -> Float
  ) -> Bool {
    #if DEBUG
      let capturedAt = ProcessInfo.processInfo.systemUptime
    #endif
    let reservation = state.withLock { value -> Reservation in
      var reservation = Reservation(epoch: value.epoch)
      guard !value.closed, !value.failed else { return reservation }
      if value.rate != sampleRate || value.channels != channels {
        value.epoch = UUID()
        value.rate = sampleRate
        value.channels = channels
      }
      reservation.epoch = value.epoch
      let needed = frameCount > 0 ? (frameCount - 1) / 8192 + 1 : 0
      guard (1...8).contains(needed), (1...2).contains(channels),
        sampleRate.isFinite, (8000...192000).contains(sampleRate), value.free.count >= needed
      else {
        value.epoch = UUID()
        value.failed = true
        #if DEBUG
          value.failureCode = value.free.count < needed ? .overflow : .invalidFrame
        #endif
        value.readable = false
        reservation.epoch = value.epoch
        reservation.failed = true
        return reservation
      }
      for position in 0..<needed {
        if let index = value.free.popLast() {
          reservation.indices[position] = Int32(index)
          reservation.count += 1
        }
      }
      return reservation
    }
    guard reservation.count > 0 else {
      if reservation.failed { failure(reservation.epoch) }
      return false
    }
    var valid = true
    for position in 0..<reservation.count {
      let slot = slots[Int(reservation.indices[position])]
      let offset = position * 8192
      let count = min(8192, frameCount - offset)
      for frame in 0..<count {
        var sum: Float = 0
        for channel in 0..<channels {
          let value = sample(offset + frame, channel)
          if !value.isFinite || abs(value) > 1 { valid = false }
          sum += value
        }
        slot.samples[frame] = sum / Float(channels)
      }
      #if DEBUG
        slot.capturedAt = capturedAt
      #endif
      slot.count = count
      slot.sampleRate = sampleRate
      slot.epoch = reservation.epoch
    }
    if !valid {
      let failedEpoch = state.withLock { value -> UUID? in
        for position in 0..<reservation.count {
          value.free.append(Int(reservation.indices[position]))
        }
        guard value.epoch == reservation.epoch, !value.closed else { return nil }
        value.epoch = UUID()
        value.failed = true
        #if DEBUG
          value.failureCode = .invalidFrame
        #endif
        value.readable = false
        return value.epoch
      }
      if let failedEpoch { failure(failedEpoch) }
      return false
    }
    let accepted = state.withLock { value -> Bool in
      guard value.epoch == reservation.epoch, !value.closed else { return false }
      value.readable = true
      return true
    }
    for position in 0..<reservation.count { continuation.yield(Int(reservation.indices[position])) }
    return accepted
  }
  private let failure: @Sendable (UUID) -> Void
}
