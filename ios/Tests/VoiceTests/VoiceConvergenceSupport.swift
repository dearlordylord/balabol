import Conversation
import Foundation

@testable import Voice

/// Faults gate delivery before HTTP starts; successful data always comes from production adapters.
actor ConvergenceVoiceControl: VoiceControl {
  let real: HTTPVoiceControl
  var blocked = false
  var waiting = false
  var interrupted = false
  var readyCount = 0
  var reads = 0
  init(_ real: HTTPVoiceControl) { self.real = real }
  func block() { blocked = true }
  func release() { blocked = false }
  func languages() async throws -> VoiceLanguages { try await real.languages() }
  func start(requestId: UUID, muted: Bool) async throws -> VoiceJoin {
    try await real.start(requestId: requestId, muted: muted)
  }
  func resolve(admissions: [VoiceAdmissionAssociation]) async throws -> VoiceAdmissionResolution {
    try await real.resolve(admissions: admissions)
  }
  func retain(admissions: [VoiceAdmissionAssociation]) async {
    await real.retain(admissions: admissions)
  }
  func snapshot(sessionId: UUID, after: Int) async throws -> VoiceSnapshot {
    while blocked {
      waiting = true
      try await Task.sleep(for: .milliseconds(10))
    }
    waiting = false
    reads += 1
    return try await real.snapshot(sessionId: sessionId, after: after)
  }
  func mute(sessionId: UUID, muted: Bool) async throws {
    try await real.mute(sessionId: sessionId, muted: muted)
  }
  func end(sessionId: UUID) async throws { try await real.end(sessionId: sessionId) }
  func seal(sessionId: UUID) async throws -> VoiceSealResult {
    try await real.seal(sessionId: sessionId)
  }
  func ready(sessionId: UUID, manifest: VoiceAudioManifest) async throws -> VoiceSnapshot {
    readyCount += 1
    return try await real.ready(sessionId: sessionId, manifest: manifest)
  }
  func interrupt(sessionId: UUID, target: VoiceOutputIdentity) async throws -> VoiceSnapshot {
    _ = try await real.interrupt(sessionId: sessionId, target: target)
    interrupted = true
    throw VoiceFailure.connection  // Server committed; response delivery was lost.
  }
}

actor ConvergenceConversationTransport: ConversationTransport {
  let real: HTTPConversationTransport
  var blocked = true
  var disconnected = false
  var recoveryWaiting = false
  var sends = 0
  var retries = 0
  var reads = 0
  init(_ real: HTTPConversationTransport) { self.real = real }
  func release() { blocked = false }
  func send(_ delivery: PendingDelivery) async throws -> ConversationMessage {
    sends += 1
    return try await real.send(delivery)
  }
  func currentTurn() async throws -> CurrentTurn? { try await real.currentTurn() }
  func olderHistory(before: Int?) async throws -> OlderHistoryPage {
    try await real.olderHistory(before: before)
  }
  func history(after: Int?) async throws -> HistoryPage { try await real.history(after: after) }
  func retryReply(for inputDeliveryId: UUID) async throws -> ReplySnapshot {
    retries += 1
    return try await real.retryReply(for: inputDeliveryId)
  }
  func interruptReply(responseId: UUID, inputDeliveryId: UUID) async throws -> ReplySnapshot? {
    try await real.interruptReply(responseId: responseId, inputDeliveryId: inputDeliveryId)
  }
  func replySnapshot(for inputDeliveryId: UUID) async throws -> ReplySnapshot {
    while blocked {
      recoveryWaiting = true
      try await Task.sleep(for: .milliseconds(10))
    }
    reads += 1
    return try await real.replySnapshot(for: inputDeliveryId)
  }
  func observeReply(for inputDeliveryId: UUID) async throws -> ReplyObservation {
    let observation = try await real.observeReply(for: inputDeliveryId)
    let pair = AsyncThrowingStream<ReplySnapshot, any Error>.makeStream()
    let task = Task {
      defer { observation.cancel() }
      do {
        for try await snapshot in observation.events {
          pair.continuation.yield(snapshot)
          if snapshot.state == .delivering {
            disconnected = true
            pair.continuation.finish(throwing: ConversationFailure.unavailable)
            return
          }
        }
        pair.continuation.finish()
      } catch { pair.continuation.finish(throwing: error) }
    }
    return ReplyObservation(
      events: pair.stream,
      cancel: {
        task.cancel()
        observation.cancel()
        pair.continuation.finish()
      })
  }
}

@MainActor final class ConvergenceMedia: VoiceMedia {
  var prepared: [VoiceOutputIdentity] = []
  var stops = 0
  var audio: (@Sendable (VoiceOutputIdentity) -> Void)?
  func requestPermission() async -> Bool { true }
  func connect(
    _ join: VoiceJoin, initiallyMuted: Bool, failure: @escaping @Sendable () -> Void,
    speechStarted: @escaping @MainActor @Sendable () -> Void,
    outputReceived: @escaping @Sendable (VoiceOutputIdentity) -> Void
  ) async throws { audio = outputReceived }
  func mute(_ muted: Bool) async throws {}
  func disconnect() async {}
  func prepareOutput(_ manifest: VoiceAudioManifest) async throws {
    prepared.append(manifest.identity)
    audio?(manifest.identity)
  }
  func stopOutput() -> Task<Void, Never> {
    stops += 1
    return Task {}
  }
}
