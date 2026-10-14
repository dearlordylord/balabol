import Foundation
import Observation

#if canImport(Conversation)
  import Conversation
#endif

/// Concrete task interpreter. Capture cancellation does not cancel observation
/// of already handed final admission; generation fencing is separate from cancel.
@MainActor @Observable public final class VoiceViewModel {
  public private(set) var state = VoiceState()
  public private(set) var output = VoiceOutputState()
  @ObservationIgnored private var languageTask: Task<Void, Never>?
  @ObservationIgnored private var outputTask: Task<Void, Never>?
  @ObservationIgnored private var interruptionTask: Task<Void, Never>?
  @ObservationIgnored private var outputRequest = UUID()
  @ObservationIgnored private let control: any VoiceControl
  @ObservationIgnored private let media: any VoiceMedia
  @ObservationIgnored private let retryClock: any VoiceRetryClock
  @ObservationIgnored private let checkpoint: any VoiceAdmissionCheckpoint
  @ObservationIgnored private let refreshConversation: @MainActor () -> Void
  @ObservationIgnored private var retryTask: Task<Void, Never>?
  @ObservationIgnored private var restoreTask: Task<Void, Never>?
  @ObservationIgnored private var resolutionTask: Task<Void, Never>?
  @ObservationIgnored private var checkpointTask: Task<Void, Never>?
  @ObservationIgnored private let accepted: @MainActor (ConversationMessage) -> Void
  @ObservationIgnored private var startTask: Task<Void, Never>?
  @ObservationIgnored private var observationTask: Task<Void, Never>?
  @ObservationIgnored private var stopTask: Task<Void, Never>?
  @ObservationIgnored private var serverEndTask: Task<Void, Never>?
  @ObservationIgnored private var muteTask: Task<Void, Never>?

  public init(
    control: any VoiceControl, media: any VoiceMedia,
    checkpoint: any VoiceAdmissionCheckpoint = VolatileVoiceAdmissionCheckpoint(),
    retryClock: any VoiceRetryClock = SystemVoiceRetryClock(),
    refreshConversation: @escaping @MainActor () -> Void = {},
    accepted: @escaping @MainActor (ConversationMessage) -> Void
  ) {
    self.control = control
    self.media = media
    self.accepted = accepted
    self.retryClock = retryClock
    self.checkpoint = checkpoint
    self.refreshConversation = refreshConversation
  }
  public func restore() async {
    guard !state.isRetired, !state.checkpointLoaded else { return }
    if restoreTask == nil {
      let checkpoint = checkpoint
      restoreTask = Task { [weak self] in
        do { self?.receive(.restored(try await checkpoint.load())) } catch {
          self?.receive(.failed(self?.state.generation ?? -1, .checkpointUnavailable))
        }
      }
    }
    await restoreTask?.value
    if !state.checkpointLoaded { restoreTask = nil }
  }
  public func loadLanguages() async {
    receive(.loadLanguages)
    await languageTask?.value
  }
  public func start() { receive(.start) }
  public func end() {
    cutOutput()
    receive(.end)
  }
  public func inputIntent(_ deliveryId: UUID) { cutOutput(nextInput: deliveryId) }
  public func speechStarted() { cutOutput() }
  public func toggleMute() { receive(.mute) }
  public func shutdown() async {
    cutOutput()
    receive(.shutdown)
    // Fence and quiesce every producer before draining the latest checkpoint.
    await languageTask?.value
    await retryTask?.value
    await startTask?.value
    await muteTask?.value
    await observationTask?.value
    await resolutionTask?.value
    await restoreTask?.value
    await stopTask?.value
    await serverEndTask?.value
    await interruptionTask?.value
    await outputTask?.value
    await checkpointTask?.value
    retryTask = nil
    observationTask = nil
    resolutionTask = nil
    checkpointTask = nil
    interruptionTask = nil
    outputTask = nil
  }
  private func receive(_ event: VoiceEvent) {
    for command in state.transition(event) { execute(command) }
  }
  private func execute(_ command: VoiceCommand) {
    switch command {
    case .refreshLanguages: receive(.loadLanguages)
    case .loadLanguages(let request):
      let control = control
      languageTask = Task { [weak self] in
        let result: Result<VoiceLanguages, VoiceFailure>
        do { result = .success(try await control.languages()) } catch {
          result = .failure(error as? VoiceFailure ?? .connection)
        }
        guard !Task.isCancelled else { return }
        self?.receive(.languagesLoaded(request, result))
      }
    case .begin(let generation):
      output = VoiceOutputState()
      interruptionTask?.cancel()
      outputRequest = UUID()
      outputTask?.cancel()
      observationTask?.cancel()
      let control = control
      let media = media
      let priorOutput = outputTask
      let priorInterruption = interruptionTask
      let priorStart = startTask
      let priorStop = stopTask
      startTask = Task { [weak self] in
        await self?.restore()
        await priorStart?.value
        await priorStop?.value
        await priorOutput?.value
        await priorInterruption?.value
        guard !Task.isCancelled, self?.state.checkpointLoaded == true else { return }
        let allowed = await media.requestPermission()
        self?.receive(.permission(generation, allowed))
        guard allowed, !Task.isCancelled, self?.state.generation == generation,
          self?.state.capture == .connecting
        else { return }
        var join: VoiceJoin?
        do {
          guard let requestId = self?.state.startRequestId,
            let requestedMute = self?.state.startMuted
          else { return }
          let value = try await control.start(requestId: requestId, muted: requestedMute)
          join = value
          guard !Task.isCancelled, self?.state.capture == .connecting else {
            try? await control.end(sessionId: value.sessionId)
            return
          }
          self?.receive(.bootstrapped(generation, value.sessionId, value.backendIncarnationId))
          let initiallyMuted =
            requestedMute || self?.state.wantsMuted == true
            || self?.state.hasPendingAdmission == true
          try await media.connect(
            value, initiallyMuted: initiallyMuted,
            failure: { [weak self] in
              Task { @MainActor in
                guard self?.state.generation == generation else { return }
                self?.cutOutput()
                self?.receive(.failed(generation, .connection))
              }
            },
            speechStarted: { [weak self] in
              guard self?.state.generation == generation, self?.state.capture == .listening else {
                return
              }
              self?.speechStarted()
            },
            outputReceived: { [weak self] identity in
              Task { @MainActor in
                guard self?.state.generation == generation else { return }
                self?.receiveOutput(.audioReceived(identity))
              }
            })
          guard !Task.isCancelled, self?.state.generation == generation,
            self?.state.capture == .connecting
          else {
            await media.disconnect()
            try? await control.end(sessionId: value.sessionId)
            return
          }
          self?.receive(.connected(generation, value.sessionId, initiallyMuted))
        } catch {
          await media.disconnect()
          if let join { try? await control.end(sessionId: join.sessionId) }
          let failure = error as? VoiceFailure ?? .connection
          self?.receive(.failed(generation, failure))
        }
      }
    case .cancelStart:
      startTask?.cancel()
      muteTask?.cancel()
    case .disconnect(let generation, let session):
      receiveOutput(.disconnected)
      let media = media
      let control = control
      if let session {
        let previous = serverEndTask
        previous?.cancel()
        serverEndTask = Task {
          await previous?.value
          guard !Task.isCancelled else { return }
          try? await control.end(sessionId: session)
        }
      }
      let previousStop = stopTask
      stopTask = Task { [weak self] in
        await previousStop?.value
        await media.disconnect()
        self?.receive(.ended(generation))
      }
    case .setMuted(let generation, let session, let muted):
      let media = media
      let control = control
      let previousMute = muteTask
      previousMute?.cancel()
      muteTask = Task { [weak self] in
        await previousMute?.value
        guard !Task.isCancelled else { return }
        do {
          try await media.mute(muted)
          guard !Task.isCancelled else { return }
          try await control.mute(sessionId: session, muted: muted)
          self?.receive(.muted(generation, muted))
        } catch { self?.receive(.failed(generation, error as? VoiceFailure ?? .capture)) }
      }
    case .observe(let generation, let session):
      let control = control
      let previous = observationTask
      previous?.cancel()
      observationTask = Task { [weak self] in
        await previous?.value
        while !Task.isCancelled {
          do {
            guard let self, self.state.generation == generation else { return }
            let page = try await control.snapshot(sessionId: session, after: self.state.sequence)
            guard !Task.isCancelled, self.state.generation == generation, !self.state.isRetired
            else { return }
            self.receive(.snapshot(generation, page))
            for event in page.events {
              guard !Task.isCancelled, self.state.generation == generation, !self.state.isRetired
              else { return }
              self.receive(.wire(generation, event))
              if let value = event.output {
                self.receiveOutput(value, sequence: event.sequence, generation: generation)
              }
            }
            if let value = page.output {
              self.receiveOutput(value, sequence: page.sequence, generation: generation)
            }
            if page.status == "ended", !self.state.hasPendingAdmission { return }
            try await Task.sleep(for: .milliseconds(250))
          } catch {
            guard !Task.isCancelled else { return }
            self?.receive(.observationFailed(generation, error as? VoiceFailure ?? .connection))
            // Final admission is read-only retryable after network uncertainty.
            guard self?.state.hasPendingAdmission == true else { return }
            try? await Task.sleep(for: .seconds(1))
          }
        }
      }
    case .retry(let generation, let milliseconds):
      let previousRetry = retryTask
      previousRetry?.cancel()
      let clock = retryClock
      retryTask = Task { [weak self] in
        await previousRetry?.value
        guard !Task.isCancelled else { return }
        do {
          try await clock.sleep(milliseconds: milliseconds)
          guard !Task.isCancelled else { return }
          self?.receive(.retryReady(generation))
        } catch {}
      }
    case .cancelRetry: retryTask?.cancel()
    case .cancelProducers:
      languageTask?.cancel()
      retryTask?.cancel()
      startTask?.cancel()
      restoreTask?.cancel()
      muteTask?.cancel()
      observationTask?.cancel()
      resolutionTask?.cancel()
    case .checkpoint(let revision, let admissions):
      let previous = checkpointTask
      let checkpoint = checkpoint
      let control = control
      checkpointTask = Task { [weak self] in
        await previous?.value
        do {
          try await checkpoint.save(admissions)
          await control.retain(admissions: admissions)
          self?.receive(.checkpointSaved(revision))
        } catch { self?.receive(.checkpointFailed(revision)) }
      }
    case .resolve(let admissions):
      guard !admissions.isEmpty else { return }
      let previous = resolutionTask
      previous?.cancel()
      let control = control
      let clock = retryClock
      resolutionTask = Task { [weak self] in
        await previous?.value
        var step = 0
        while !Task.isCancelled {
          guard let self, !self.state.associations.isEmpty else { return }
          let requested = self.state.pendingAssociations
          do {
            let response = try await control.resolve(admissions: requested)
            guard !Task.isCancelled else { return }
            self.receive(.resolved(requested, response))
            if self.state.associations.isEmpty { return }
          } catch {
            guard !Task.isCancelled else { return }
            let failure = error as? VoiceFailure ?? .connection
            self.receive(.resolutionFailed(failure))
            switch failure {
            case .connection: break
            case .backend(let code, _):
              guard ["Unavailable", "StorageUnavailable", "VoiceBusy"].contains(code) else {
                return
              }
            default: return
            }
          }
          do {
            try await clock.sleep(milliseconds: [500, 1000, 2000, 4000, 8000][min(step, 4)])
          } catch { return }
          step = min(step + 1, 4)
        }
      }
    case .refreshConversation: refreshConversation()
    case .accepted(let receipt):
      receiveOutput(.inputAccepted(receipt.deliveryId))
      accepted(receipt)
    }
  }

  private func receiveOutput(_ value: VoiceOutput, sequence: Int, generation: Int) {
    guard state.generation == generation, [.listening, .muted].contains(state.capture),
      let session = state.sessionId, value.isValid(sessionId: session)
    else { return }
    receiveOutput(.observed(sequence: sequence, value))
  }
  private func receiveOutput(_ event: VoiceOutputEvent) {
    for command in output.transition(event) { executeOutput(command) }
  }
  private func cutOutput(nextInput: UUID? = nil) {
    let pending = state.pendingAssociations.map(\.deliveryId)
    receiveOutput(.cut(nextInput: nextInput, pendingInputs: pending))
  }
  private func executeOutput(_ command: VoiceOutputCommand) {
    switch command {
    case .prepare(let manifest):
      outputRequest = UUID()
      let request = outputRequest
      let generation = state.generation
      let priorOutput = outputTask
      priorOutput?.cancel()
      let stopped = media.stopOutput()
      let media = media
      let control = control
      outputTask = Task { [weak self] in
        do {
          await stopped.value
          await priorOutput?.value
          guard !Task.isCancelled, self?.outputRequest == request else { return }
          try await media.prepareOutput(manifest)
          guard !Task.isCancelled, self?.outputRequest == request,
            self?.state.generation == generation
          else { return }
          let page = try await control.ready(sessionId: manifest.sessionId, manifest: manifest)
          guard !Task.isCancelled, self?.outputRequest == request else { return }
          if let latest = page.output {
            self?.receiveOutput(latest, sequence: page.sequence, generation: generation)
          }
        } catch {
          guard !Task.isCancelled, self?.outputRequest == request else { return }
          self?.receiveOutput(.failed(manifest.identity))
        }
      }
    case .suppress(let target):
      // A rejected old identity must not stop an authorized newer track.
      let active = target == nil || target == output.current?.identity
      let stopped: Task<Void, Never>
      if active {
        outputRequest = UUID()
        outputTask?.cancel()
        stopped = media.stopOutput()
      } else {
        stopped = Task {}
      }
      guard let target, let session = state.sessionId else { return }
      let priorInterruption = interruptionTask
      priorInterruption?.cancel()
      let control = control
      interruptionTask = Task {
        await stopped.value
        await priorInterruption?.value
        guard !Task.isCancelled else { return }
        _ = try? await control.interrupt(sessionId: session, target: target)
      }
    }
  }
}
