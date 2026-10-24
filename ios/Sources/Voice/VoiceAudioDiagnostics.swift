import CryptoKit
import Foundation
import os

#if DEBUG
  internal struct VoiceAudioDiagnosticBudget {
    private var stages: [String: Int] = [:]
    private var windows = 0
    mutating func admit(_ stage: String, periodic: Bool = false) -> Bool {
      if periodic {
        guard windows < 30 else { return false }
        windows += 1
      } else {
        guard stages[stage, default: 0] < 12 else { return false }
        stages[stage, default: 0] += 1
      }
      return true
    }
  }
#endif

#if DEBUG
  extension VoiceFailure {
    var traceKind: String {
      switch self {
      case .permissionDenied: "PermissionDenied"
      case .capture: "Capture"
      case .connection: "Connection"
      case .invalidResponse: "InvalidResponse"
      case .checkpointUnavailable: "CheckpointUnavailable"
      case .unexpectedOperation: "UnexpectedOperation"
      case .backend: "Backend"
      }
    }
    var traceBackendCode: String? {
      guard case .backend(let code, _) = self else { return nil }
      switch code {
      case "SessionNotFound", "StartExpired", "VoiceBusy", "Unavailable", "StorageUnavailable",
        "Unauthorized", "InvalidRequest", "RecognitionFailed", "InvalidRecognition",
        "SynthesisFailed",
        "AudioUnavailable",
        "ActivityFailed", "VoiceActivityFailed", "AdmissionFailed", "ConversationFailed":
        return code
      default: return "OtherBackendCode"
      }
    }
  }
  extension VoiceActivityError {
    var traceStatus: String {
      switch self {
      case .invalidFrame: "InvalidFrame"
      case .invalidProbability: "InvalidProbability"
      case .modelUnavailable: "ModelUnavailable"
      case .inference: "Inference"
      case .overflow: "Overflow"
      }
    }
  }
  extension VoicePlatformEvent {
    var traceStatus: String {
      switch self {
      case .interrupted: "Interrupted"
      case .resumeRecommended(let allowed): allowed ? "ResumeRecommended" : "ResumeNotRecommended"
      case .routeChanged(let removed): removed ? "PrivateOutputRemoved" : "RouteChanged"
      case .servicesLost: "ServicesLost"
      case .servicesReset: "ServicesReset"
      }
    }
  }
  internal struct VoiceTraceRecord: Codable, Sendable {
    let cause: VoiceTraceCause
    let uptime: Double
    let session: String?
    let response: String?
    let input: String?
    let outputEpoch: String?
    let microphoneEpoch: String?
    let status: String?
    let failureKind: String?
    let backendCode: String?
    let httpStatus: Int?
    let networkCode: Int?
    let nativeCapture: VoiceCaptureDiagnostic?
    let captureDevice: VoiceCaptureDeviceSnapshot?
    let capturedAt: Double?
    let classifiedAt: Double?
  }
  internal struct VoiceTraceSnapshot: Codable, Sendable {
    let run: UUID
    let wallAnchor: Date
    let monotonicAnchor: Double
    var dropped = 0
    var events: [VoiceTraceRecord] = []
  }
  // Only scalar records enter this lock; all encoding and disk I/O use one writer.
  internal final class VoiceTransitionTrace: Sendable {
    static let shared = VoiceTransitionTrace()
    private struct State {
      var snapshot = VoiceTraceSnapshot(
        run: UUID(), wallAnchor: Date(), monotonicAnchor: ProcessInfo.processInfo.systemUptime)
      var destination: URL?
      var scheduled = false
      var revision = 0
      var reportedFailure = false
    }
    private let state = OSAllocatedUnfairLock(initialState: State())
    private let writer = DispatchQueue(label: "balabol.voice.transition-trace", qos: .utility)
    private let reportFailure: @Sendable () -> Void
    init(
      reportFailure: @escaping @Sendable () -> Void = {
        NSLog("Balabol voice transition diagnostics could not be persisted")
      }
    ) { self.reportFailure = reportFailure }
    static func hash(_ value: UUID) -> String {
      SHA256.hash(data: Data(value.uuidString.lowercased().utf8))
        .map { String(format: "%02x", $0) }.joined().prefix(32).description
    }
    func configure(destination: URL?) {
      state.withLock { $0.destination = destination }
      record(.enabled)
    }
    func record(
      _ cause: VoiceTraceCause, target: VoiceOutputIdentity? = nil,
      microphone: UUID? = nil, status: String? = nil,
      capturedAt: Double? = nil, classifiedAt: Double? = nil,
      failure: VoiceFailure? = nil, session: UUID? = nil,
      httpStatus: Int? = nil, networkCode: Int? = nil, nativeCapture: VoiceCaptureDiagnostic? = nil, captureDevice: VoiceCaptureDeviceSnapshot? = nil
    ) {
      let event = VoiceTraceRecord(
        cause: cause, uptime: ProcessInfo.processInfo.systemUptime,
        session: session.map(Self.hash),
        response: target.map { Self.hash($0.responseId) },
        input: target.map { Self.hash($0.inputDeliveryId) },
        outputEpoch: target.map { Self.hash($0.outputEpoch) },
        microphoneEpoch: microphone.map(Self.hash), status: status.map { String($0.prefix(32)) },
        failureKind: failure?.traceKind, backendCode: failure?.traceBackendCode,
        httpStatus: httpStatus, networkCode: networkCode, nativeCapture: nativeCapture, captureDevice: captureDevice,
        capturedAt: capturedAt, classifiedAt: classifiedAt)
      let schedule = state.withLock { value in
        guard value.destination != nil else { return false }
        if value.snapshot.events.count == 128 {
          value.snapshot.events.removeFirst()
          value.snapshot.dropped += 1
        }
        value.snapshot.events.append(event)
        value.revision += 1
        guard !value.scheduled else { return false }
        value.scheduled = true
        return true
      }
      if schedule { writer.async { self.persist() } }
    }
    private func persist() {
      while true {
        let (snapshot, destination, revision) = state.withLock {
          ($0.snapshot, $0.destination, $0.revision)
        }
        if let destination {
          do {
            let data = try JSONEncoder().encode(snapshot)
            guard data.count <= 131072 else { throw CocoaError(.fileWriteOutOfSpace) }
            try FileManager.default.createDirectory(
              at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
            #if os(iOS)
              try data.write(
                to: destination,
                options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            #else
              try data.write(to: destination, options: .atomic)
            #endif
            try FileManager.default.setAttributes(
              [.posixPermissions: 0o600], ofItemAtPath: destination.path)
          } catch {
            let report = state.withLock { value in
              guard !value.reportedFailure else { return false }
              value.reportedFailure = true
              return true
            }
            if report { reportFailure() }
          }
        }
        let done = state.withLock { value in
          guard value.revision == revision else { return false }
          value.scheduled = false
          return true
        }
        if done { return }
      }
    }
    func flush() { writer.sync {} }
    var snapshot: VoiceTraceSnapshot { state.withLock { $0.snapshot } }
  }
#endif

internal struct VoiceAudioProcessingSnapshot: Codable, Sendable {
  let stage: String
  let uptimeSeconds: Double
  let category: String
  let mode: String
  let inputPortTypes: [String]
  let outputPortTypes: [String]
  let sampleRate: Double
  let ioDurationSeconds: Double
  let requestedAEC: Bool?
  let requestedAECMode: String?
  let effectiveAEC: String
  let softwareAECResolved: Bool
  let softwareAECActive: Bool
  let platformAECResolved: Bool?
  let platformAECActive: Bool?
  let vpioEnabledRequested: Bool
  let vpioEnabledActive: Bool
  let vpioBypassRequested: Bool
  let vpioBypassActive: Bool
  let levels: Levels?
  struct Levels: Codable, Sendable {
    let rms: Float
    let peak: Float
    let frames: Int
    let onset: Bool?
  }
}
#if DEBUG
  internal struct VoiceAudioProcessingJournal: Codable, Sendable {
    let dropped: Int
    let events: [VoiceAudioProcessingSnapshot]
    static let empty = Self(dropped: 0, events: [])
    func appending(_ event: VoiceAudioProcessingSnapshot) -> Self {
      Self(
        dropped: dropped + (events.count == 128 ? 1 : 0),
        events: Array(events.suffix(127)) + [event])
    }
  }
  /// Bounded scalar snapshots only; one utility writer owns encoding and protected atomic I/O.
  internal final class VoiceAudioProcessingTrace: @unchecked Sendable {
    static let shared = VoiceAudioProcessingTrace(
      destination:
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
        .appendingPathComponent("balabol-voice-audio-processing.json"))
    private let destination: URL?
    private let writer = DispatchQueue(label: "balabol.voice.audio-processing", qos: .utility)
    private var journal = VoiceAudioProcessingJournal.empty
    private var reportedFailure = false
    init(destination: URL?) { self.destination = destination }
    func record(_ event: VoiceAudioProcessingSnapshot) {
      writer.async { self.persist(event) }
    }
    func reportEncodingFailure() {
      writer.async { self.reportFailure() }
    }
    private func reportFailure() {
      guard !reportedFailure else { return }
      reportedFailure = true
      NSLog("Balabol audio-processing diagnostics could not be persisted")
    }
    private func persist(_ event: VoiceAudioProcessingSnapshot) {
      journal = journal.appending(event)
      guard let destination else { return }
      do {
        let data = try JSONEncoder().encode(journal)
        guard data.count <= 131072 else { throw CocoaError(.fileWriteOutOfSpace) }
        try FileManager.default.createDirectory(
          at: destination.deletingLastPathComponent(),
          withIntermediateDirectories: true)
        #if os(iOS)
          try data.write(
            to: destination,
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
          try data.write(to: destination, options: .atomic)
        #endif
        try FileManager.default.setAttributes(
          [.posixPermissions: 0o600], ofItemAtPath: destination.path)
      } catch {
        reportFailure()
      }
    }
    func flush() { writer.sync {} }
    var snapshot: VoiceAudioProcessingJournal { writer.sync { journal } }
  }
#endif
