import XCTest

@testable import Voice

final class VoiceActivityTests: XCTestCase {
  func testNoiseIsNotSpeechAndTwoActualModelWindowsQualifyOnset() throws {
    var state = VoiceActivityDecision()
    for _ in 0..<100 { XCTAssertFalse(try state.accept(0.1)) }
    XCTAssertFalse(try state.accept(0.9))
    XCTAssertTrue(try state.accept(0.9))
    XCTAssertFalse(try state.accept(0.9))
    for _ in 0..<7 { XCTAssertFalse(try state.accept(0)) }
    XCTAssertFalse(try state.accept(0.9))
    XCTAssertTrue(try state.accept(0.9))
    XCTAssertThrowsError(try state.accept(.nan))
  }
  func testSampleDurationAndFrameContentAreIndependentOfCallbackPartition() throws {
    for rate in [16000, 44100, 48000] {
      let samples = (0..<rate).map { Float($0 % 31) / 100 }
      func frames(_ partition: Int) throws -> [[Float]] {
        var framer = VoiceActivityFramer()
        var result: [[Float]] = []
        try samples.withUnsafeBufferPointer { source in
          var offset = 0
          while offset < source.count {
            let count = min(partition, source.count - offset)
            result += try framer.append(
              UnsafeBufferPointer(rebasing: source[offset..<(offset + count)]),
              sampleRate: Double(rate))
            offset += count
          }
        }
        return result
      }
      let reference = try frames(8192)
      XCTAssertEqual(reference.count, 31)
      for partition in [137, rate / 100] {
        let actual = try frames(partition)
        XCTAssertEqual(actual.count, reference.count, "rate \(rate) partition \(partition)")
        let delta = zip(actual.flatMap { $0 }, reference.flatMap { $0 }).reduce(Float.zero) {
          max($0, abs($1.0 - $1.1))
        }
        XCTAssertLessThan(delta, 0.000001, "rate \(rate) partition \(partition)")
      }
    }
  }
}

extension VoiceActivityTests {
  func testPinnedRealClassifierFileOnlySilenceAndReset() async throws {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
    let model = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(
      ".local/share/balabol/models/vad/silero-v6.2.3.onnx")
    guard FileManager.default.fileExists(atPath: model.path) else {
      throw XCTSkip("Pinned file-only model fixture is not provisioned")
    }
    let classifier = try SileroVoiceClassifier(
      modelURL: model, manifestURL: root.appendingPathComponent("src/voice/activity-model.json"))
    let silence = [Float](repeating: 0, count: 512)
    let first = try await classifier.probability(silence)
    XCTAssertEqual(first, 0.0016698241, accuracy: 0.000001)
    _ = try await classifier.probability(silence)
    await classifier.reset()
    let reset = try await classifier.probability(silence)
    XCTAssertEqual(reset, first)
    do {
      _ = try await classifier.probability([0])
      XCTFail("Invalid frames must fail")
    } catch { XCTAssertEqual(error as? VoiceActivityError, .invalidFrame) }
  }
}

extension VoiceActivityTests {
  func testResamplingRejectsOutOfBandTonesInsteadOfAliasingIntoSpeechBand() throws {
    for rate in [32000, 48000] {
      var framer = VoiceActivityFramer()
      var result: [Float] = []
      let samples = (0..<rate).map {
        Float(0.5 * sin(2 * Double.pi * 12000 * Double($0) / Double(rate)))
      }
      try samples.withUnsafeBufferPointer { source in
        var offset = 0
        while offset < source.count {
          let count = min(480, source.count - offset)
          let frames = try framer.append(
            UnsafeBufferPointer(rebasing: source[offset..<(offset + count)]),
            sampleRate: Double(rate))
          result += frames.flatMap { $0 }
          offset += count
        }
      }
      let steady = result.dropFirst(1024)
      let rms = sqrt(steady.reduce(0.0) { $0 + Double($1) * Double($1) } / Double(steady.count))
      XCTAssertLessThan(rms, 0.005, "12kHz input must not alias to a loud4kHzVADtone")
    }
  }
}

#if DEBUG
  extension VoiceActivityTests {
    func testTransitionTraceBoundsPersistsAndHashesWithoutRawIdentifiers() throws {
      let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
        UUID().uuidString)
      defer { try? FileManager.default.removeItem(at: directory) }
      let file = directory.appendingPathComponent("trace.json")
      let trace = VoiceTransitionTrace()
      trace.configure(destination: file)
      let response = UUID()
      let target = VoiceOutputIdentity(
        inputDeliveryId: UUID(), responseId: response, outputEpoch: UUID())
      for _ in 0..<300 { trace.record(.interruptDispatch, target: target) }
      trace.flush()
      let data = try Data(contentsOf: file)
      let snapshot = try JSONDecoder().decode(VoiceTraceSnapshot.self, from: data)
      XCTAssertEqual(snapshot.events.count, 128)
      XCTAssertEqual(snapshot.dropped, 173)
      XCTAssertLessThanOrEqual(data.count, 131072)
      XCTAssertEqual(snapshot.events.last?.response, VoiceTransitionTrace.hash(response))
      XCTAssertEqual(snapshot.events.last?.response?.count, 12)
      XCTAssertFalse(String(decoding: data, as: UTF8.self).contains(response.uuidString))
      XCTAssertEqual(
        VoiceTransitionTrace.hash(
          try XCTUnwrap(UUID(uuidString: "00000000-0000-0000-0000-000000000000"))), "12b9377cbe7e")
      // A non-directory destination exercises harmless disk failure, not audio failure.
      trace.configure(destination: file.appendingPathComponent("impossible"))
      trace.record(.speech)
      trace.flush()
      XCTAssertEqual(trace.snapshot.events.last?.cause, .speech)
    }
  }
#endif
