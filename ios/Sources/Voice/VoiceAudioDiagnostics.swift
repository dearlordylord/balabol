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
  internal enum VoiceTraceCause: String, Codable, Sendable {
    case enabled, speech, input, platform, captureFailure, cut, end, shutdown
    case output, localStop, localStopped, interruptDispatch, interruptReturned, interruptFailed
    case onset, onsetAccepted, onsetRejected, audioReceived, playoutPrepared
  }
  internal struct VoiceTraceRecord: Codable, Sendable {
    let cause: VoiceTraceCause
    let uptime: Double
    let response: String?
    let input: String?
    let outputEpoch: String?
    let microphoneEpoch: String?
    let status: String?
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
    }
    private let state = OSAllocatedUnfairLock(initialState: State())
    private let writer = DispatchQueue(label: "balabol.voice.transition-trace", qos: .utility)
    static func hash(_ value: UUID) -> String {
      SHA256.hash(data: Data(value.uuidString.lowercased().utf8))
        .map { String(format: "%02x", $0) }.joined().prefix(12).description
    }
    func configure(destination: URL?) {
      state.withLock { $0.destination = destination }
      record(.enabled)
    }
    func record(
      _ cause: VoiceTraceCause, target: VoiceOutputIdentity? = nil,
      microphone: UUID? = nil, status: String? = nil,
      capturedAt: Double? = nil, classifiedAt: Double? = nil
    ) {
      let event = VoiceTraceRecord(
        cause: cause, uptime: ProcessInfo.processInfo.systemUptime,
        response: target.map { Self.hash($0.responseId) },
        input: target.map { Self.hash($0.inputDeliveryId) },
        outputEpoch: target.map { Self.hash($0.outputEpoch) },
        microphoneEpoch: microphone.map(Self.hash), status: status.map { String($0.prefix(32)) },
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
        if let destination, let data = try? JSONEncoder().encode(snapshot), data.count <= 131072 {
          try? FileManager.default.createDirectory(
            at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
          #if os(iOS)
            try? data.write(
              to: destination,
              options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
          #else
            try? data.write(to: destination, options: .atomic)
          #endif
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
