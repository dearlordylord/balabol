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

  func testRetryIsSingleSoftToneAndFailureHasTwoSeparatedTonesWithoutLateReplay() {
    var tone = VoiceProgressTone()
    tone.play(.retrying, now: 10, sampleRate: 24000)
    let retry = (0..<7000).map { _ in tone.next(now: 10) }
    XCTAssertTrue(retry.prefix(2160).contains { abs($0) > 0.01 })
    XCTAssertLessThanOrEqual(retry.map(abs).max() ?? 1, 0.022)
    XCTAssertTrue(retry.dropFirst(2160).allSatisfy { $0 == 0 })
    tone.play(.failed, now: 11, sampleRate: 24000)
    let failed = (0..<7000).map { _ in tone.next(now: 11) }
    XCTAssertTrue(failed.prefix(2160).contains { abs($0) > 0.01 })
    XCTAssertTrue(failed[2160..<4080].allSatisfy { $0 == 0 })
    XCTAssertTrue(failed[4080..<6240].contains { abs($0) > 0.01 })
    tone.play(.failed, now: 12, sampleRate: 24000)
    XCTAssertEqual(tone.next(now: 13), 0)
  }

  func testTerminalOutputCleanupPreservesFailureToneButSpeechAlwaysCancelsIt() {
    var tone = VoiceProgressTone()
    tone.play(.failed, now: 10, sampleRate: 24000)
    tone.cancel(preservingFailure: true)
    XCTAssertTrue((0..<400).contains { _ in abs(tone.next(now: 10)) > 0.01 })
    tone.cancel()
    for _ in 0..<120 { _ = tone.next(now: 10) }
    XCTAssertEqual(tone.next(now: 10), 0)
    tone.play(.retrying, now: 11, sampleRate: 24000)
    tone.cancel(preservingFailure: true)
    for _ in 0..<120 { _ = tone.next(now: 11) }
    XCTAssertEqual(tone.next(now: 11), 0)
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
