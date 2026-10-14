import Foundation
import Observation

#if canImport(Conversation)
  import Conversation
#endif

/// Concrete task interpreter. Capture cancellation does not cancel observation
/// of already handed final admission; generation fencing is separate from cancel.
@MainActor @Observable public final class VoiceViewModel {
  public private(set) var state = VoiceState()
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
  public func end() { receive(.end) }
  public func toggleMute() { receive(.mute) }
  public func shutdown() async {
    end()
    await stopTask?.value
    observationTask?.cancel()
    observationTask = nil
  }
  private func receive(_ event: VoiceEvent) {
    for command in state.transition(event) { execute(command) }
  }
  private func execute(_ command: VoiceCommand) {
    switch command {
    case .begin(let generation):
      observationTask?.cancel()
      let control = control
      let media = media
      let priorStart = startTask
      let priorStop = stopTask
      startTask = Task { [weak self] in
        await priorStart?.value
        await priorStop?.value
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
          try await media.connect(value) { [weak self] in
            Task { @MainActor in self?.receive(.failed(generation, .connection)) }
          }
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
            for event in page.events { self.receive(.wire(generation, event)) }
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
    case .accepted(let receipt): accepted(receipt)
    }
  }
}
