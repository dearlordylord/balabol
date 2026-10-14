import XCTest

@testable import Voice

final class VoiceOnsetTrackerTests: XCTestCase {
  func testIsolatedTwentyMillisecondTransientAndQuietNeverStartSpeech() {
    var tracker = VoiceOnsetTracker()
    XCTAssertNil(tracker.process(peak: 0.03, frameCount: 960, sampleRate: 48000))
    XCTAssertNil(tracker.process(peak: 0, frameCount: 19200, sampleRate: 48000))
  }
  func testFiftyNineMillisecondsDoesNotStartAndSixtiethMillisecondStartsOnce() {
    var tracker = VoiceOnsetTracker()
    XCTAssertNil(tracker.process(peak: 0.03, frameCount: 2832, sampleRate: 48000))
    XCTAssertNotNil(tracker.process(peak: 0.03, frameCount: 48, sampleRate: 48000))
    XCTAssertNil(tracker.process(peak: 0.03, frameCount: 48000, sampleRate: 48000))
  }
  func testAnyQuietResetsPartialQualification() {
    var tracker = VoiceOnsetTracker()
    XCTAssertNil(tracker.process(peak: 0.03, frameCount: 2400, sampleRate: 48000))
    XCTAssertNil(tracker.process(peak: 0, frameCount: 48, sampleRate: 48000))
    XCTAssertNil(tracker.process(peak: 0.03, frameCount: 2400, sampleRate: 48000))
    XCTAssertNotNil(tracker.process(peak: 0.03, frameCount: 480, sampleRate: 48000))
  }
  func testPersistentVoiceEmitsOnceUntilExistingTwoHundredMillisecondQuietRearm() {
    var tracker = VoiceOnsetTracker()
    XCTAssertNotNil(tracker.process(peak: 0.03, frameCount: 2880, sampleRate: 48000))
    XCTAssertNil(tracker.process(peak: 0, frameCount: 9552, sampleRate: 48000))
    XCTAssertNil(tracker.process(peak: 0.03, frameCount: 48000, sampleRate: 48000))
    XCTAssertNil(tracker.process(peak: 0, frameCount: 9600, sampleRate: 48000))
    XCTAssertNotNil(tracker.process(peak: 0.03, frameCount: 2880, sampleRate: 48000))
  }
  func testDurationUsesActualSamplesAcrossCallbackSizesAndRates() {
    var tracker = VoiceOnsetTracker()
    XCTAssertNil(tracker.process(peak: 0.03, frameCount: 441, sampleRate: 44100))
    XCTAssertNil(tracker.process(peak: 0.03, frameCount: 240, sampleRate: 48000))
    XCTAssertNil(tracker.process(peak: 0.03, frameCount: 160, sampleRate: 16000))
    XCTAssertNil(tracker.process(peak: 0.03, frameCount: 1323, sampleRate: 44100))
    XCTAssertNotNil(tracker.process(peak: 0.03, frameCount: 240, sampleRate: 48000))
  }
  func testResetCreatesFreshMicrophoneLifetimeAndInvalidBuffersCannotStartSpeech() {
    var tracker = VoiceOnsetTracker()
    XCTAssertNil(tracker.process(peak: 0.03, frameCount: 2400, sampleRate: 48000))
    tracker = VoiceOnsetTracker()
    XCTAssertNil(tracker.process(peak: 0.03, frameCount: 960, sampleRate: 48000))
    XCTAssertNil(tracker.process(peak: .nan, frameCount: 2880, sampleRate: 48000))
    XCTAssertNil(tracker.process(peak: 0.03, frameCount: 2880, sampleRate: 0))
    XCTAssertNil(tracker.process(peak: 0.03, frameCount: 0, sampleRate: 48000))
  }
  func testExistingPeakThresholdIsUnchanged() {
    var tracker = VoiceOnsetTracker()
    XCTAssertNil(tracker.process(peak: 0.0249, frameCount: 48000, sampleRate: 48000))
    XCTAssertNotNil(tracker.process(peak: 0.025, frameCount: 2880, sampleRate: 48000))
  }

  func testQueuedOnsetCannotCrossMuteUnmuteEpochAndFreshOnsetStillActs() throws {
    var tracker = VoiceOnsetTracker()
    let queued = try XCTUnwrap(tracker.process(peak: 0.03, frameCount: 2880, sampleRate: 48000))
    XCTAssertTrue(tracker.isCurrent(queued))
    tracker.reset(epoch: UUID())  // Mute retires notices already computed outside the render lock.
    tracker.reset(epoch: UUID())  // Unmute starts another capture lifetime in the same room.
    XCTAssertFalse(tracker.isCurrent(queued))
    let fresh = try XCTUnwrap(tracker.process(peak: 0.03, frameCount: 2880, sampleRate: 48000))
    XCTAssertTrue(tracker.isCurrent(fresh))
    XCTAssertFalse(tracker.isCurrent(queued))
  }

}
