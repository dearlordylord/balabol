import Foundation
import Observation

#if canImport(Conversation)
  import Conversation
#endif

/// One writer drains boundary facts without reentrancy: each command batch is
/// installed before the next queued event is reduced.
@MainActor @Observable public final class VoiceViewModel {
  public private(set) var state = VoiceState()
  public var output: VoiceOutputState { state.output }
  @ObservationIgnored private var interpreter: VoiceTaskInterpreter?
  @ObservationIgnored private var pendingInputs: [VoiceInput] = []
  @ObservationIgnored private var isDraining = false

  public init(
    control: any VoiceControl, media: any VoiceMedia,
    checkpoint: any VoiceAdmissionCheckpoint = VolatileVoiceAdmissionCheckpoint(),
    retryClock: any VoiceRetryClock = SystemVoiceRetryClock(),
    refreshConversation: @escaping @MainActor () -> Void = {},
    interruptConversation: @escaping @MainActor ([UUID], Task<Void, Never>) -> Void = { _, _ in },
    accepted: @escaping @MainActor (ConversationMessage) -> Void
  ) {
    interpreter = VoiceTaskInterpreter(
      control: control, media: media, checkpoint: checkpoint, clock: retryClock,
      receive: { [weak self] event in self?.receive(event) }, accepted: accepted,
      refresh: refreshConversation, interrupt: interruptConversation)
  }

  public func restore() async {
    receive(.restore)
    await interpreter?.waitForRestore()
  }

  public func loadLanguages() async {
    receive(.loadLanguages)
    await interpreter?.waitForLanguages()
  }

  public func start() { receive(.start) }
  public func resume() { receive(.resume) }
  public func end() { receive(.end) }
  public func generationCue(input: UUID, response: UUID, cue: VoiceProgressCue) {
    receive(.generationCue(input: input, response: response, cue: cue))
  }
  public func cancelGenerationCue() { receive(.cancelGenerationCue) }
  public func inputIntent(_ deliveryId: UUID) { receive(.inputIntent(deliveryId)) }
  public func speechStarted() { receive(.speechIntent) }
  public func toggleMute() { receive(.mute) }

  public func shutdown() async {
    receive(.shutdown)
    await interpreter?.drain()
  }

  private func receive(_ event: VoiceFeatureEvent) {
    pendingInputs.append(VoiceInput(event: event, proposedStartRequestId: UUID()))
    guard !isDraining else { return }
    isDraining = true
    defer { isDraining = false }
    while !pendingInputs.isEmpty {
      let input = pendingInputs.removeFirst()
      let transition = transitionVoice(state, input)
      state = transition.state
      for command in transition.commands { interpreter?.execute(command) }
    }
  }
}
