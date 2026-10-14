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
  @ObservationIgnored private var outputTask: Task<Void, Never>?
  @ObservationIgnored private var interruptionTask: Task<Void, Never>?
  @ObservationIgnored private var outputRequest = UUID()
  @ObservationIgnored private let control: any VoiceControl
  @ObservationIgnored private let media: any VoiceMedia
  @ObservationIgnored private let accepted: @MainActor (ConversationMessage) -> Void
  @ObservationIgnored private var startTask: Task<Void, Never>?
  @ObservationIgnored private var observationTask: Task<Void, Never>?
  @ObservationIgnored private var stopTask: Task<Void, Never>?
  @ObservationIgnored private var muteTask: Task<Void, Never>?

  public init(
    control: any VoiceControl, media: any VoiceMedia,
    accepted: @escaping @MainActor (ConversationMessage) -> Void
  ) {
    self.control = control
    self.media = media
    self.accepted = accepted
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
    end()
    await stopTask?.value
    await interruptionTask?.value
    await outputTask?.value
    interruptionTask = nil
    outputTask = nil
    observationTask?.cancel()
    observationTask = nil
  }
  private func receive(_ event: VoiceEvent) {
    for command in state.transition(event) { execute(command) }
  }
  private func execute(_ command: VoiceCommand) {
    switch command {
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
        await priorStart?.value
        await priorStop?.value
        await priorOutput?.value
        await priorInterruption?.value
        guard !Task.isCancelled else { return }
        let allowed = await media.requestPermission()
        self?.receive(.permission(generation, allowed))
        guard allowed, !Task.isCancelled, self?.state.generation == generation,
          self?.state.capture == .connecting
        else { return }
        var join: VoiceJoin?
        do {
          let value = try await control.start()
          join = value
          guard !Task.isCancelled, self?.state.capture == .connecting else {
            try? await control.end(sessionId: value.sessionId)
            return
          }
          self?.receive(.bootstrapped(generation, value.sessionId))
          try await media.connect(
            value,
            failure: { [weak self] in
              Task { @MainActor in
                guard self?.state.generation == generation else { return }
                self?.cutOutput()
                self?.receive(.failed(generation, .connection))
              }
            },
            speechStarted: { [weak self] in
              Task { @MainActor in
                guard self?.state.generation == generation, self?.state.capture == .listening else {
                  return
                }
                self?.speechStarted()
              }
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
          self?.receive(.connected(generation, value.sessionId))
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
      stopTask = Task { [weak self] in
        let remoteEnd: Task<Void, Never>? = session.map { id in
          Task { try? await control.end(sessionId: id) }
        }
        await media.disconnect()
        await remoteEnd?.value
        self?.receive(.ended(generation))
      }
    case .setMuted(let generation, let session, let muted):
      let media = media
      let control = control
      muteTask = Task { [weak self] in
        do {
          try await media.mute(muted)
          guard !Task.isCancelled else { return }
          try await control.mute(sessionId: session, muted: muted)
          self?.receive(.muted(generation, muted))
        } catch { self?.receive(.failed(generation, error as? VoiceFailure ?? .capture)) }
      }
    case .observe(let generation, let session):
      let control = control
      observationTask = Task { [weak self] in
        while !Task.isCancelled {
          do {
            guard let self, self.state.generation == generation else { return }
            let page = try await control.snapshot(sessionId: session, after: self.state.sequence)
            self.receive(.snapshot(generation, page))
            for event in page.events {
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
            self?.receive(.observationFailed(generation))
            // Final admission is read-only retryable after network uncertainty.
            guard self?.state.hasPendingAdmission == true else { return }
            try? await Task.sleep(for: .seconds(1))
          }
        }
      }
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
    let pending = state.utterances.filter {
      switch state.admissions[$0] {
      case .saving, .checking: true
      default: false
      }
    }
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
