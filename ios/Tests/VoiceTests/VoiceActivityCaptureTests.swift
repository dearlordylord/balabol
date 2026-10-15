import XCTest
import os

@testable import Voice

private actor ControlledActivity: VoiceActivityClassifier {
  private var continuation: CheckedContinuation<Float, any Error>?
  private var entered = false
  private var waiters: [CheckedContinuation<Void, Never>] = []
  private var hold = true
  private var value: Float
  init(_ value: Float = 0.9) { self.value = value }
  func probability(_ frame: [Float]) async throws -> Float {
    guard frame.count == 512 else { throw VoiceActivityError.invalidFrame }
    entered = true
    for waiter in waiters { waiter.resume() }
    waiters.removeAll()
    if hold { return try await withCheckedThrowingContinuation { continuation = $0 } }
    return value
  }
  func reset() {}
  func wait() async {
    if entered { return }
    await withCheckedContinuation { waiters.append($0) }
  }
  func release(fail: Bool = false) {
    hold = false
    if fail {
      continuation?.resume(throwing: VoiceActivityError.inference)
    } else {
      continuation?.resume(returning: value)
    }
    continuation = nil
  }
}
final class VoiceActivityCaptureTests: XCTestCase {
  func testResetFencesHeldInferenceAndAClassifiedFreshLowEnergyPhraseCanInterrupt() async throws {
    let classifier = ControlledActivity()
    let observations = OSAllocatedUnfairLock(initialState: (onsets: [UUID](), failures: [UUID]()))
    let capture = VoiceActivityCapture(
      classifier: classifier,
      started: { epoch, _ in observations.withLock { $0.onsets.append(epoch) } },
      failed: { epoch in observations.withLock { $0.failures.append(epoch) } })
    XCTAssertTrue(
      capture.capture(frameCount: 1024, channels: 1, sampleRate: 16000, sample: { _, _ in 0.0001 }))
    await classifier.wait()
    capture.reset()
    await classifier.release(fail: true)
    for _ in 0..<100 { await Task.yield() }
    XCTAssertTrue(observations.withLock { $0.onsets.isEmpty && $0.failures.isEmpty })
    XCTAssertTrue(
      capture.capture(frameCount: 1024, channels: 1, sampleRate: 16000, sample: { _, _ in 0.0001 }))
    for _ in 0..<1000 {
      if observations.withLock({ !$0.onsets.isEmpty }) { break }
      await Task.yield()
    }
    XCTAssertEqual(observations.withLock { $0.onsets.count }, 1)
    await capture.stop()
    XCTAssertFalse(
      capture.capture(frameCount: 512, channels: 1, sampleRate: 16000, sample: { _, _ in 1 }))
  }
  func testFinitePoolOverflowFencesAllQueuedAndHeldOnsets() async {
    let classifier = ControlledActivity()
    let observations = OSAllocatedUnfairLock(initialState: (onsets: 0, failures: 0))
    let capture = VoiceActivityCapture(
      classifier: classifier,
      started: { _, _ in observations.withLock { $0.onsets += 1 } },
      failed: { _ in observations.withLock { $0.failures += 1 } })
    XCTAssertTrue(
      capture.capture(frameCount: 1024, channels: 1, sampleRate: 16000, sample: { _, _ in 0.1 }))
    await classifier.wait()
    for _ in 0..<7 {
      XCTAssertTrue(
        capture.capture(frameCount: 1024, channels: 1, sampleRate: 16000, sample: { _, _ in 0.1 }))
    }
    XCTAssertFalse(
      capture.capture(frameCount: 1024, channels: 1, sampleRate: 16000, sample: { _, _ in 0.1 }))
    await classifier.release()
    await capture.stop()
    XCTAssertEqual(observations.withLock { $0.onsets }, 0)
    XCTAssertEqual(observations.withLock { $0.failures }, 1)
  }
  func testLoudNonSpeechProbabilityNeverBecomesAnOnset() async {
    let classifier = ControlledActivity(0.01)
    await classifier.release()
    let observations = OSAllocatedUnfairLock(initialState: 0)
    let capture = VoiceActivityCapture(
      classifier: classifier,
      started: { _, _ in observations.withLock { $0 += 1 } }, failed: { _ in })
    XCTAssertTrue(
      capture.capture(frameCount: 8192, channels: 2, sampleRate: 48000, sample: { _, _ in 0.9 }))
    await classifier.wait()
    for _ in 0..<100 { await Task.yield() }
    await capture.stop()
    XCTAssertEqual(observations.withLock { $0 }, 0)
  }
}

extension VoiceActivityCaptureTests {
  func testLargeTwoHundredMillisecondMonoAndStereoCallbacksUseFiniteMultipleSlots() async {
    for channels in [1, 2] {
      let classifier = ControlledActivity()
      await classifier.release()
      let observations = OSAllocatedUnfairLock(initialState: (onsets: 0, failures: 0))
      let capture = VoiceActivityCapture(
        classifier: classifier,
        started: { _, _ in observations.withLock { $0.onsets += 1 } },
        failed: { _ in observations.withLock { $0.failures += 1 } })
      XCTAssertTrue(
        capture.capture(
          frameCount: 9600, channels: channels, sampleRate: 48000, sample: { _, _ in 0.01 }))
      await classifier.wait()
      for _ in 0..<1000 {
        if observations.withLock({ $0.onsets == 1 }) { break }
        await Task.yield()
      }
      XCTAssertEqual(observations.withLock { $0.onsets }, 1)
      XCTAssertEqual(observations.withLock { $0.failures }, 0)
      await capture.stop()
    }
  }
  func testInvalidSampleFromRetiredCallbackCannotFailFreshLifetime() async {
    let classifier = ControlledActivity()
    await classifier.release()
    let observations = OSAllocatedUnfairLock(initialState: (onsets: 0, failures: 0))
    let capture = VoiceActivityCapture(
      classifier: classifier,
      started: { _, _ in observations.withLock { $0.onsets += 1 } },
      failed: { _ in observations.withLock { $0.failures += 1 } })
    XCTAssertFalse(
      capture.capture(
        frameCount: 512, channels: 1, sampleRate: 16000,
        sample: { frame, _ in
          if frame == 0 {
            capture.reset()
            return .nan
          }
          return 0
        }))
    XCTAssertEqual(observations.withLock { $0.failures }, 0)
    XCTAssertTrue(
      capture.capture(frameCount: 1024, channels: 1, sampleRate: 16000, sample: { _, _ in 0.01 }))
    for _ in 0..<1000 {
      if observations.withLock({ $0.onsets == 1 }) { break }
      await Task.yield()
    }
    XCTAssertEqual(observations.withLock { $0.onsets }, 1)
    await capture.stop()
  }
}
