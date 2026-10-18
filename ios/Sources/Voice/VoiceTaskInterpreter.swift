import Foundation

#if canImport(Conversation)
  import Conversation
#endif

/// Physical resources only. Feature transitions choose every dependency and retry.
@MainActor internal final class VoiceTaskInterpreter {
  private struct Entry {
    let work: VoiceWork
    let task: Task<Void, Never>
  }
  private var entries: [VoiceRequest: Entry] = [:]
  private let control: any VoiceControl
  private let media: any VoiceMedia
  private let checkpoint: any VoiceAdmissionCheckpoint
  private let clock: any VoiceRetryClock
  private let receive: @MainActor (VoiceFeatureEvent) -> Void
  private let accepted: @MainActor (ConversationMessage) -> Void
  private let refresh: @MainActor () -> Void
  private let interrupt: @MainActor ([UUID], Task<Void, Never>) -> Void

  init(
    control: any VoiceControl, media: any VoiceMedia,
    checkpoint: any VoiceAdmissionCheckpoint, clock: any VoiceRetryClock,
    receive: @escaping @MainActor (VoiceFeatureEvent) -> Void,
    accepted: @escaping @MainActor (ConversationMessage) -> Void,
    refresh: @escaping @MainActor () -> Void,
    interrupt: @escaping @MainActor ([UUID], Task<Void, Never>) -> Void
  ) {
    self.control = control
    self.media = media
    self.checkpoint = checkpoint
    self.clock = clock
    self.receive = receive
    self.accepted = accepted
    self.refresh = refresh
    self.interrupt = interrupt
  }

  func execute(_ command: VoiceEffectCommand) {
    switch command {
    case .run(let request, let work, let after): run(request, work, after: after)
    case .cancel(let requests):
      for request in requests { entries[request]?.task.cancel() }
    case .accepted(let message): accepted(message)
    case .refreshConversation: refresh()
    case .generationCue(let cue): media.playCue(cue)
    case .cancelGenerationCue: media.cancelCue()
    case .interruptConversation(let inputs, let request):
      let stopped = entries[request]?.task ?? Task {}
      interrupt(inputs, stopped)
    #if DEBUG
      case .trace(let cause, let target, let status, let failure, let session):
        VoiceTransitionTrace.shared.record(
          cause, target: target, status: status, failure: failure, session: session)
    #endif
    }
  }

  func waitForRestore() async {
    let tasks = entries.values.compactMap { entry -> Task<Void, Never>? in
      if case .restoreCheckpoint = entry.work { return entry.task }
      return nil
    }
    for task in tasks { await task.value }
  }

  func waitForLanguages() async {
    let tasks = entries.values.compactMap { entry -> Task<Void, Never>? in
      if case .languages = entry.work { return entry.task }
      return nil
    }
    for task in tasks { await task.value }
  }

  func drain() async {
    while !entries.isEmpty {
      let tasks = entries.values.map(\.task)
      for task in tasks { await task.value }
    }
  }

  private func run(_ request: VoiceRequest, _ work: VoiceWork, after: [VoiceRequest]) {
    let dependencies = after.compactMap { entries[$0]?.task }
    // These fences run synchronously, before any new physical operation can start.
    let stopped = stopBarrier(work)
    let task = Task { [self] in
      for dependency in dependencies { await dependency.value }
      await stopped?.value
      let result: VoiceWorkResult
      if Task.isCancelled { result = .cancelled }
      else {
        do { result = try await perform(work, request: request) }
        // The typed boundary permits only intentional task cancellation here.
        catch { result = .cancelled }
      }
      // Completion may synchronously reserve a dependent task, which captures this
      // exact handle before it is removed. Completed handles never form a journal.
      receive(.completed(request, result))
      entries.removeValue(forKey: request)
    }
    entries[request] = Entry(work: work, task: task)
  }

  private func stopBarrier(_ work: VoiceWork) -> Task<Void, Never>? {
    guard case .stopMedia(let capture, let output, let target, let session, let preservingFailureCue) = work else {
      return nil
    }
    let captureStopped = capture ? media.fenceCapture() : nil
    #if DEBUG
      if output { VoiceTransitionTrace.shared.record(.localStop, target: target, session: session) }
    #endif
    let outputStopped = output ? media.stopOutput(preservingFailureCue: preservingFailureCue) : nil
    return Task {
      await captureStopped?.value
      await outputStopped?.value
      #if DEBUG
        if output {
          VoiceTransitionTrace.shared.record(.cleanupAttemptFinished, target: target, session: session)
        }
      #endif
    }
  }

  private func perform(_ work: VoiceWork, request: VoiceRequest) async throws(CancellationError) -> VoiceWorkResult {
    switch work {
    case .permission: return .permission(await media.requestPermission())
    case .languages:
      return .languages(try await attempt { try await self.control.languages() })
    case .restoreCheckpoint:
      return .restored(try await attempt(fallback: .checkpointUnavailable) {
        try await self.checkpoint.load()
      })
    case .checkpoint(_, let associations):
      return .checkpoint(try await attempt(fallback: .checkpointUnavailable) {
        try await self.checkpoint.save(associations)
        await self.control.retain(admissions: associations)
      })
    case .bootstrap(let requestId, let muted):
      return .bootstrapped(try await attempt {
        try await self.control.start(requestId: requestId, muted: muted)
      })
    case .connect(let join, let muted): return try await connect(join, muted: muted, request: request)
    case .localMute(let muted):
      return .localMuted(try await attempt(fallback: .capture) { try await self.media.mute(muted) })
    case .remoteMute(let origin, let muted):
      return .remoteMuted(try await attempt {
        try await self.control.mute(sessionId: origin.sessionId, muted: muted)
      })
    case .snapshot(let origin, let after):
      return .snapshot(try await attempt {
        try await self.control.snapshot(sessionId: origin.sessionId, after: after)
      })
    case .resolve(let associations):
      return .resolved(try await attempt { try await self.control.resolve(admissions: associations) })
    case .seal(let origin):
      return .sealed(try await attempt { try await self.control.seal(sessionId: origin.sessionId) })
    case .endBootstrap(let origin):
      return .bootstrapEnded(try await attempt {
        try await self.control.end(sessionId: origin.sessionId)
      })
    case .stopMedia: return .stopped
    case .disconnect:
      await media.disconnect()
      return .disconnected
    case .prepareOutput(let manifest):
      return .outputPrepared(try await attempt { try await self.media.prepareOutput(manifest) })
    case .ready(let origin, let manifest):
      return .ready(try await attempt {
        try await self.control.ready(sessionId: origin.sessionId, manifest: manifest)
      })
    case .interrupt(let origin, let target): return try await interruptOutput(origin, target)
    case .sleep(let milliseconds, _):
      do {
        try await clock.sleep(milliseconds: milliseconds)
        return Task.isCancelled ? .cancelled : .elapsed
      } catch {
        if Task.isCancelled { return .cancelled }
        let failure = error is CancellationError ? .connection : error as? VoiceFailure ?? .unexpectedOperation
        #if DEBUG
          VoiceTransitionTrace.shared.record(.failure, status: "TimerFailed", failure: failure)
        #endif
        return .timerFailed(failure)
      }
    case .observePlatform:
      media.observePlatform { [receive] event in receive(.platform(request, event)) }
      return .platformObserved
    case .retirePlatformObservation:
      media.retirePlatformObservation()
      return .platformRetired
    }
  }

  private func connect(_ join: VoiceJoin, muted: Bool, request: VoiceRequest) async throws(CancellationError)
    -> VoiceWorkResult
  {
    let receive = receive
    return .connected(try await attempt {
      try await self.media.connect(
        join, initiallyMuted: muted,
        failure: { Task { @MainActor in receive(.captureFailed(request)) } },
        speechStarted: { receive(.speech(request)) },
        outputReceived: { identity in
          Task { @MainActor in receive(.audioReceived(request, identity)) }
        })
    })
  }

  private func interruptOutput(_ origin: VoiceOrigin, _ target: VoiceOutputIdentity) async throws(CancellationError)
    -> VoiceWorkResult
  {
    #if DEBUG
      VoiceTransitionTrace.shared.record(
        .interruptDispatch, target: target, session: origin.sessionId)
    #endif
    let result = try await attempt {
      try await self.control.interrupt(sessionId: origin.sessionId, target: target)
    }
    #if DEBUG
      switch result {
      case .success(let page):
        VoiceTransitionTrace.shared.record(
          .interruptReturned, target: target,
          status: page.output?.identity == target ? page.output?.status.rawValue : "DifferentTarget")
      case .failure(let failure):
        VoiceTransitionTrace.shared.record(
          .interruptFailed, target: target, failure: failure, session: origin.sessionId)
      }
    #endif
    return .interrupted(result)
  }

  private func attempt<Value>(
    fallback: VoiceFailure = .connection, _ operation: () async throws -> Value
  ) async throws(CancellationError) -> Result<Value, VoiceFailure> {
    do { return .success(try await operation()) }
    catch is CancellationError {
      if Task.isCancelled { throw CancellationError() }
      return .failure(fallback)
    }
    catch {
      if let failure = error as? VoiceFailure { return .failure(failure) }
      #if DEBUG
        VoiceTransitionTrace.shared.record(
          .failure, status: "UnexpectedOperation", failure: .unexpectedOperation)
      #endif
      return .failure(.unexpectedOperation)
    }
  }
}
