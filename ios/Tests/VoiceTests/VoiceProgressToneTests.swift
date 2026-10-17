import XCTest

@testable import Voice

final class VoiceProgressToneTests: XCTestCase {
  func testToneIsShortBoundedAndExpiresRatherThanPlayingLate() {
    var tone = VoiceProgressTone()
    tone.play(.generationStarted, now: 10, sampleRate: 24000)
    let samples = (0..<4000).map { _ in tone.next(now: 10) }
    XCTAssertTrue(samples.contains { abs($0) > 0.01 })
    XCTAssertLessThanOrEqual(samples.map(abs).max() ?? 1, 0.035)
    XCTAssertTrue(samples.suffix(1000).allSatisfy { $0 == 0 })
    tone.play(.textReady, now: 11, sampleRate: 24000)
    XCTAssertEqual(tone.next(now: 12), 0)
  }

  func testSpeechCancellationFadesWithinFiveMillisecondsAndSecondCueDoesNotBurst() {
    var tone = VoiceProgressTone()
    tone.play(.generationStarted, now: 10, sampleRate: 24000)
    for _ in 0..<400 { _ = tone.next(now: 10) }
    tone.cancel()
    for _ in 0..<120 { _ = tone.next(now: 10) }
    XCTAssertEqual(tone.next(now: 10), 0)
    tone.play(.textReady, now: 10.1, sampleRate: 24000)
    XCTAssertEqual(tone.next(now: 10.1), 0)
    tone.play(.textReady, now: 11, sampleRate: 24000)
    XCTAssertTrue((0..<300).contains { _ in abs(tone.next(now: 11)) > 0.01 })
  }
}
