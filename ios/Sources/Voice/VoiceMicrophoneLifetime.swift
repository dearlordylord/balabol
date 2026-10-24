import Foundation

/// This lifetime follows explicit unmuted voice intent, not a Room generation.
/// The physical implementation remains the SDK's single managed audio engine.
internal struct VoiceMicrophoneLifetimeState: Equatable, Sendable {
  let permissionGranted: Bool
  let desired: Bool
  let revision: Int
  let settledRevision: Int
  let failure: VoiceFailure?
  let applied: Bool?
  let releaseAttempts: Int
  var releaseRequired: Bool { revision > 0 && !desired && applied != false }
  init(permissionGranted: Bool = false, desired: Bool = false, revision: Int = 0,
    settledRevision: Int = 0, failure: VoiceFailure? = nil, applied: Bool? = nil, releaseAttempts: Int = 0) {
    self.permissionGranted = permissionGranted
    self.desired = desired
    self.revision = revision
    self.settledRevision = settledRevision
    self.failure = failure
    self.applied = applied
    self.releaseAttempts = releaseAttempts
  }
  func permitting(_ allowed: Bool) -> Self {
    Self(permissionGranted: allowed, desired: desired, revision: revision,
      settledRevision: settledRevision, failure: failure, applied: applied, releaseAttempts: releaseAttempts)
  }
}

internal func reconcileVoiceMicrophoneLifetime(_ step: VoiceTransition, initialize: Bool) -> VoiceTransition {
  let state = step.state
  let lifetime = state.execution.microphoneLifetime
  let available = ![.paused, .ending, .ended, .idle].contains(state.capture)
  let desired = lifetime.permissionGranted && state.wantsListening && !state.wantsMuted
    && !state.isRetired && available
  guard desired != lifetime.desired || (initialize && lifetime.revision == 0) else { return step }
  let next = VoiceMicrophoneLifetimeState(permissionGranted: lifetime.permissionGranted,
    desired: desired, revision: lifetime.revision + 1,
    settledRevision: lifetime.settledRevision, failure: lifetime.failure, applied: lifetime.applied,
    releaseAttempts: desired ? 0 : 1)
  let updated = state.replacing(execution: state.execution.replacing(microphoneLifetime: next))
  // Install the physical intent before any synchronous room-stop fence runs.
  return VoiceTransition(state: updated,
    commands: [.microphoneLifetime(next.revision, enabled: desired)] + step.commands)
}

/// WebRTC's room teardown clears global input_running despite persistent
/// preparation. A correlated cleanup fact must renew the current user's intent.
internal func renewVoiceMicrophoneLifetime(after step: VoiceTransition, previous: VoiceState,
  event: VoiceFeatureEvent) -> VoiceTransition {
  let lifetime = step.state.execution.microphoneLifetime
  guard lifetime.desired, case .completed(let request, let result) = event,
    let operation = previous.execution.operations[request] else { return step }
  switch (operation.kind, result) {
  case (.stopMedia(true, _, _, _, _), .stopped), (.disconnect, .disconnected): break
  default: return step
  }
  let next = VoiceMicrophoneLifetimeState(permissionGranted: lifetime.permissionGranted,
    desired: true, revision: lifetime.revision + 1, settledRevision: lifetime.settledRevision,
    failure: lifetime.failure, applied: nil)
  return VoiceTransition(state: step.state.replacing(execution: step.state.execution.replacing(microphoneLifetime: next)),
    commands: [.microphoneLifetime(next.revision, enabled: true)] + step.commands)
}

internal func settleVoiceMicrophoneLifetime(_ state: VoiceState, revision: Int,
  result: Result<Void, VoiceFailure>, proposedId: UUID) -> VoiceTransition {
  let current = state.execution.microphoneLifetime
  guard revision == current.revision, revision > current.settledRevision else { return unchangedVoice(state) }
  let failure: VoiceFailure? = if case .failure(let error) = result { error } else { nil }
  let next = VoiceMicrophoneLifetimeState(permissionGranted: current.permissionGranted,
    desired: current.desired, revision: current.revision, settledRevision: revision, failure: failure,
    applied: failure == nil ? current.desired : nil, releaseAttempts: current.releaseAttempts)
  let updated = state.replacing(execution: state.execution.replacing(microphoneLifetime: next))
  guard let failure else { return unchangedVoice(updated) }
  let commands = voiceTrace(updated, .mediaCleanupFailed, failure: failure)
  if !current.desired, current.releaseAttempts < 2 {
    // One bounded compensation retry; failure after it retains an explicit
    // unknown/unreleased obligation. Dispatch never means release succeeded.
    let retry = VoiceMicrophoneLifetimeState(permissionGranted: current.permissionGranted,
      desired: false, revision: revision + 1, settledRevision: revision, failure: failure,
      applied: nil, releaseAttempts: current.releaseAttempts + 1)
    return VoiceTransition(state: updated.replacing(execution: updated.execution.replacing(microphoneLifetime: retry)),
      commands: [.microphoneLifetime(retry.revision, enabled: false)] + commands)
  }
  guard current.desired, !state.isRetired else { return VoiceTransition(state: updated, commands: commands) }
  let failed = failVoiceTransport(updated, failure, proposedId: proposedId)
  return VoiceTransition(state: failed.state, commands: commands + failed.commands)
}

/// Explicit End/shutdown may start another bounded release attempt after a
/// terminal cleanup failure; ordinary events cannot silently restart cleanup.
internal func retryVoiceMicrophoneRelease(_ step: VoiceTransition) -> VoiceTransition {
  let current = step.state.execution.microphoneLifetime
  guard current.releaseRequired, current.failure != nil,
    current.settledRevision == current.revision else { return step }
  let next = VoiceMicrophoneLifetimeState(permissionGranted: current.permissionGranted,
    desired: false, revision: current.revision + 1, settledRevision: current.settledRevision,
    failure: current.failure, applied: current.applied, releaseAttempts: 1)
  return VoiceTransition(state: step.state.replacing(execution: step.state.execution.replacing(microphoneLifetime: next)),
    commands: [.microphoneLifetime(next.revision, enabled: false)] + step.commands)
}

/// One serialized SDK setter lane. Room task cancellation cannot cancel this
/// lane: a late acquisition must finish and be compensated by the newer intent.
@MainActor internal final class VoiceMicrophoneLifetimeInterpreter {
  private let media: any VoiceMedia
  private let receive: @MainActor (VoiceFeatureEvent) -> Void
  private var latestRevision = 0
  private var desired = false
  private var applied = false
  private var failure: VoiceFailure?
  private var tail: Task<Void, Never>?
  private var running = false
  private var operation: Task<Void, any Error>?
  private var operationEnabled = false
  init(media: any VoiceMedia, receive: @escaping @MainActor (VoiceFeatureEvent) -> Void) {
    self.media = media
    self.receive = receive
  }
  func reconcile(revision: Int, enabled: Bool) {
    guard revision > latestRevision else { return }
    latestRevision = revision
    desired = enabled
    if !enabled && operationEnabled { operation?.cancel() }
    guard !running else { return }
    running = true
    tail = Task { [self] in
      // Coalesce pending intents instead of accumulating a task per toggle.
      while true {
        let revision = latestRevision
        let enabled = desired
        operationEnabled = enabled
        let operation = Task { try await media.setCaptureLifetime(enabled) }
        self.operation = operation
        do {
          try await operation.value
          applied = enabled
          failure = nil
        } catch {
          // The lane is never cancelled. Only a revoked acquisition's child is;
          // same-revision SDK cancellation remains a typed boundary failure.
          failure = error as? VoiceFailure ?? .unexpectedOperation
        }
        self.operation = nil
        operationEnabled = false
        if revision == latestRevision {
          let result: Result<Void, VoiceFailure> = failure.map { .failure($0) } ?? .success(())
          receive(.microphoneLifetimeSettled(revision, result))
          if revision == latestRevision { running = false; return }
        }
        // A late setter must settle the latest desired value before any room
        // connect or shutdown can pass this lane's barrier.
      }
    }
  }
  func settled() async {
    while let task = tail {
      let revision = latestRevision
      await task.value
      if revision == latestRevision { return }
    }
  }
  func beforeConnect(initiallyMuted: Bool) async throws {
    await settled()
    try Task.checkCancellation()
    if let failure { throw failure }
    guard initiallyMuted || (desired && applied) else { throw CancellationError() }
  }
}
