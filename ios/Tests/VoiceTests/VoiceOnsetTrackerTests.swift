import XCTest

@testable import Voice

final class VoiceOnsetTrackerTests: XCTestCase {
  func testIsolatedTwentyMillisecondTransientAndQuietNeverStartSpeech() {
    var tracker = VoiceOnsetTracker()
    XCTAssertNil(tracker.process(rms: 0.03, frameCount: 960, sampleRate: 48000))
    XCTAssertNil(tracker.process(rms: 0, frameCount: 19200, sampleRate: 48000))
  }
  func testFiftyNineMillisecondsDoesNotStartAndSixtiethMillisecondStartsOnce() {
    var tracker = VoiceOnsetTracker()
    XCTAssertNil(tracker.process(rms: 0.03, frameCount: 2832, sampleRate: 48000))
    XCTAssertNotNil(tracker.process(rms: 0.03, frameCount: 48, sampleRate: 48000))
    XCTAssertNil(tracker.process(rms: 0.03, frameCount: 48000, sampleRate: 48000))
  }
  func testAnyQuietResetsPartialQualification() {
    var tracker = VoiceOnsetTracker()
    XCTAssertNil(tracker.process(rms: 0.03, frameCount: 2400, sampleRate: 48000))
    XCTAssertNil(tracker.process(rms: 0, frameCount: 48, sampleRate: 48000))
    XCTAssertNil(tracker.process(rms: 0.03, frameCount: 2400, sampleRate: 48000))
    XCTAssertNotNil(tracker.process(rms: 0.03, frameCount: 480, sampleRate: 48000))
  }
  func testPersistentVoiceEmitsOnceUntilExistingTwoHundredMillisecondQuietRearm() {
    var tracker = VoiceOnsetTracker()
    XCTAssertNotNil(tracker.process(rms: 0.03, frameCount: 2880, sampleRate: 48000))
    XCTAssertNil(tracker.process(rms: 0, frameCount: 9552, sampleRate: 48000))
    XCTAssertNil(tracker.process(rms: 0.03, frameCount: 48000, sampleRate: 48000))
    XCTAssertNil(tracker.process(rms: 0, frameCount: 9600, sampleRate: 48000))
    XCTAssertNotNil(tracker.process(rms: 0.03, frameCount: 2880, sampleRate: 48000))
  }
  func testDurationUsesActualSamplesAcrossCallbackSizesAndRates() {
    var tracker = VoiceOnsetTracker()
    XCTAssertNil(tracker.process(rms: 0.03, frameCount: 441, sampleRate: 44100))
    XCTAssertNil(tracker.process(rms: 0.03, frameCount: 240, sampleRate: 48000))
    XCTAssertNil(tracker.process(rms: 0.03, frameCount: 160, sampleRate: 16000))
    XCTAssertNil(tracker.process(rms: 0.03, frameCount: 1323, sampleRate: 44100))
    XCTAssertNotNil(tracker.process(rms: 0.03, frameCount: 240, sampleRate: 48000))
  }
  func testResetCreatesFreshMicrophoneLifetimeAndInvalidBuffersCannotStartSpeech() {
    var tracker = VoiceOnsetTracker()
    XCTAssertNil(tracker.process(rms: 0.03, frameCount: 2400, sampleRate: 48000))
    tracker = VoiceOnsetTracker()
    XCTAssertNil(tracker.process(rms: 0.03, frameCount: 960, sampleRate: 48000))
    XCTAssertNil(tracker.process(rms: .nan, frameCount: 2880, sampleRate: 48000))
    XCTAssertNil(tracker.process(rms: 0.03, frameCount: 2880, sampleRate: 0))
    XCTAssertNil(tracker.process(rms: 0.03, frameCount: 0, sampleRate: 48000))
  }
  func testNormalizedRMSThresholdRejectsLowEnergyAndAcceptsBoundary() {
    var tracker = VoiceOnsetTracker()
    XCTAssertNil(tracker.process(rms: 0.0059, frameCount: 48000, sampleRate: 48000))
    XCTAssertNotNil(tracker.process(rms: 0.006, frameCount: 2880, sampleRate: 48000))
  }

  func testQueuedOnsetCannotCrossMuteUnmuteEpochAndFreshOnsetStillActs() throws {
    var tracker = VoiceOnsetTracker()
    let queued = try XCTUnwrap(tracker.process(rms: 0.03, frameCount: 2880, sampleRate: 48000))
    XCTAssertTrue(tracker.isCurrent(queued))
    tracker.reset(epoch: UUID())  // Mute retires notices already computed outside the render lock.
    tracker.reset(epoch: UUID())  // Unmute starts another capture lifetime in the same room.
    XCTAssertFalse(tracker.isCurrent(queued))
    let fresh = try XCTUnwrap(tracker.process(rms: 0.03, frameCount: 2880, sampleRate: 48000))
    XCTAssertTrue(tracker.isCurrent(fresh))
    XCTAssertFalse(tracker.isCurrent(queued))
  }

  func testCompleteBufferRMSRejectsSparseEarlyPeaksAndIncludesSpeechAfterFirst2048Frames() throws {
    let sparse = try XCTUnwrap(
      measure(
        frameCount: 9600, channelCount: 1, sample: { frame, _ in frame == 0 ? 0.5 : 0 }))
    XCTAssertEqual(sparse.peak, 0.5)
    XCTAssertLessThan(sparse.rms, 0.006)
    var tracker = VoiceOnsetTracker()
    XCTAssertNil(tracker.process(rms: sparse.rms, frameCount: 9600, sampleRate: 48000))
    let laterSpeech = try XCTUnwrap(
      measure(
        frameCount: 9600, channelCount: 1, sample: { frame, _ in frame < 2048 ? 0 : 0.01 }))
    XCTAssertGreaterThan(laterSpeech.rms, 0.006)
    XCTAssertNotNil(tracker.process(rms: laterSpeech.rms, frameCount: 9600, sampleRate: 48000))
  }

  func testCaptureMeasurementIncludesBothChannelsAndRejectsInvalidSamples() throws {
    let stereo = try XCTUnwrap(
      measure(
        frameCount: 480, channelCount: 2, sample: { _, channel in channel == 0 ? 0 : 0.01 }))
    XCTAssertEqual(stereo.rms, Float(0.01 / sqrt(2)), accuracy: 0.000001)
    XCTAssertNil(measure(frameCount: 0, channelCount: 1, sample: { _, _ in 0 }))
    XCTAssertNil(
      measure(frameCount: 480, channelCount: 0, sample: { _, _ in 0 }))
    XCTAssertNil(
      measure(frameCount: 480, channelCount: 3, sample: { _, _ in 0 }))
    XCTAssertNil(
      measure(frameCount: 480, channelCount: 1, sample: { _, _ in .nan }))
    XCTAssertNil(
      measure(frameCount: 480, channelCount: 1, sample: { _, _ in 1.1 }))
  }

  func testOneMillisecondTransientCannotBorrowTwoHundredMillisecondCallbackDuration() throws {
    var tracker = VoiceOnsetTracker()
    let result = try XCTUnwrap(
      tracker.processCapture(
        frameCount: 9600, channelCount: 1, sampleRate: 48000,
        sample: { frame, _ in frame < 48 ? 0.1 : 0 }))
    XCTAssertGreaterThan(result.energy.rms, 0.006)
    XCTAssertNil(result.onset)
  }

  func testCaptureOnsetIsIndependentOfCallbackPartitionAcrossRatesAndChannels() throws {
    for rate in [16000, 44100, 48000] {
      for channels in [1, 2] {
        let frameCount = rate / 5
        func qualified(_ partitions: [Int], transient: Bool) throws -> Int {
          var tracker = VoiceOnsetTracker()
          var offset = 0
          var notices = 0
          var partitionIndex = 0
          while offset < frameCount {
            let count = min(partitions[partitionIndex % partitions.count], frameCount - offset)
            partitionIndex += 1
            let start = offset
            let result = try XCTUnwrap(
              tracker.processCapture(
                frameCount: count, channelCount: channels, sampleRate: Double(rate),
                sample: { frame, _ in
                  if transient { return start + frame < rate / 1000 ? 0.1 : 0 }
                  return start + frame < rate / 20 ? 0 : 0.01
                }))
            if result.onset != nil { notices += 1 }
            offset += count
          }
          return notices
        }
        for count in [1, 137, rate / 100, frameCount] {
          XCTAssertEqual(try qualified([count], transient: true), 0)
          XCTAssertEqual(try qualified([count], transient: false), 1)
        }
        XCTAssertEqual(try qualified([rate / 200, rate * 3 / 200], transient: true), 0)
        XCTAssertEqual(try qualified([rate / 200, rate * 3 / 200], transient: false), 1)
      }
    }
  }

  private func measure(
    frameCount: Int, channelCount: Int,
    sample: (_ frame: Int, _ channel: Int) -> Float
  ) -> VoiceCaptureEnergy? {
    var tracker = VoiceOnsetTracker()
    return tracker.processCapture(
      frameCount: frameCount, channelCount: channelCount, sampleRate: 48000, sample: sample)?.energy
  }

}
