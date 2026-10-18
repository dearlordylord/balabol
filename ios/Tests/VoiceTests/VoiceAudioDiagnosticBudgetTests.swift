import XCTest

@testable import Voice

#if DEBUG
  final class VoiceAudioDiagnosticBudgetTests: XCTestCase {
    private func fixture() throws -> VoiceAudioProcessingSnapshot {
      let json = """
        {"stage":"playback-first-nonzero","uptimeSeconds":12.5,"category":"playAndRecord","mode":"voiceChat","inputPortTypes":["MicrophoneBuiltIn"],"outputPortTypes":["Speaker"],"sampleRate":48000,"ioDurationSeconds":0.02,"requestedAEC":true,"requestedAECMode":"automatic","effectiveAEC":"software","softwareAECResolved":true,"softwareAECActive":true,"platformAECResolved":false,"platformAECActive":false,"vpioEnabledRequested":true,"vpioEnabledActive":false,"vpioBypassRequested":false,"vpioBypassActive":true,"levels":{"rms":0.1,"peak":0.3,"frames":1024,"onset":false}}
        """
      return try JSONDecoder().decode(VoiceAudioProcessingSnapshot.self, from: Data(json.utf8))
    }
    func testJournalRetainsBoundedActualReadbacksAndSafeLevels() throws {
      let record = try fixture()
      let journal = (0..<140).reduce(VoiceAudioProcessingJournal.empty) { value, _ in
        value.appending(record)
      }
      XCTAssertEqual(journal.events.count, 128)
      XCTAssertEqual(journal.dropped, 12)
      let data = try JSONEncoder().encode(journal)
      XCTAssertLessThanOrEqual(data.count, 131072)
      let decoded = try JSONDecoder().decode(VoiceAudioProcessingJournal.self, from: data)
      XCTAssertEqual(decoded.events.first?.vpioEnabledRequested, true)
      XCTAssertEqual(decoded.events.first?.vpioEnabledActive, false)
      XCTAssertEqual(decoded.events.first?.levels?.frames, 1024)
      let text = String(decoding: data, as: UTF8.self)
      for forbidden in ["pcm", "transcript", "apiKey", "sessionId", "responseId"] {
        XCTAssertFalse(text.contains(forbidden))
      }
    }
    func testAtomicPrivateJournalSurvivesWriteFailureAndRetries() throws {
      let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
        UUID().uuidString)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      defer { try? FileManager.default.removeItem(at: directory) }
      let destination = directory.appendingPathComponent("trace.json")
      try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
      let trace = VoiceAudioProcessingTrace(destination: destination)
      trace.record(try fixture())
      trace.flush()
      XCTAssertEqual(trace.snapshot.events.count, 1)
      try FileManager.default.removeItem(at: destination)
      trace.record(try fixture())
      trace.flush()
      let restored = try JSONDecoder().decode(
        VoiceAudioProcessingJournal.self, from: Data(contentsOf: destination))
      XCTAssertEqual(restored.events.count, 2)
      let permissions =
        try FileManager.default.attributesOfItem(atPath: destination.path)[.posixPermissions]
        as? Int
      XCTAssertEqual(permissions, 0o600)
    }
    func testLifecycleStagesAreBoundedIndependentlyAndWindowsShareOneRunBudget() {
      var budget = VoiceAudioDiagnosticBudget()
      for _ in 0..<12 { XCTAssertTrue(budget.admit("route-change")) }
      XCTAssertFalse(budget.admit("route-change"))
      XCTAssertTrue(budget.admit("app-background"))
      for index in 0..<30 {
        XCTAssertTrue(
          budget.admit(
            index.isMultiple(of: 2) ? "capture-window" : "playback-window", periodic: true))
      }
      XCTAssertFalse(budget.admit("capture-window", periodic: true))
      XCTAssertFalse(budget.admit("playback-window", periodic: true))
    }
  }
#endif
