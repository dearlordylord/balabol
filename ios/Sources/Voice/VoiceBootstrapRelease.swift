import Foundation

/// The returned late producer remains an exact release obligation until its
/// control port acknowledges closure. Shutdown preserves both attempts and waits.
internal func releaseVoiceBootstrap(_ state: VoiceState, origin: VoiceOrigin) -> VoiceTransition {
  let release = state.execution.bootstrapReleases[origin]
    ?? VoiceBootstrapRelease(origin: origin, lastFailure: nil)
  let retained = state.replacing(execution: state.execution.replacing(
    bootstrapReleases: state.execution.bootstrapReleases.merging([origin: release]) { _, new in new }))
  return retryVoiceBootstrapRelease(retained, origin: origin)
}

internal func retryVoiceBootstrapRelease(_ state: VoiceState, origin: VoiceOrigin) -> VoiceTransition {
  guard state.execution.bootstrapReleases[origin] != nil,
    !hasVoiceOperation(state, where: { kind in
      switch kind {
      case .endBootstrap(let known), .sleep(_, .bootstrapCleanup(let known)): known == origin
      default: false
      }
    }) else { return unchangedVoice(state) }
  return reserveVoice(state, .endBootstrap(origin))
}

internal func completeVoiceBootstrapRelease(_ state: VoiceState, origin: VoiceOrigin,
  result: Result<Void, VoiceFailure>) -> VoiceTransition {
  guard state.execution.bootstrapReleases[origin] != nil else { return unchangedVoice(state) }
  switch result {
  case .success:
    return unchangedVoice(state.replacing(execution: state.execution.replacing(
      bootstrapReleases: state.execution.bootstrapReleases.filter { $0.key != origin })))
  case .failure(let failure):
    let retained = state.replacing(execution: state.execution.replacing(
      bootstrapReleases: state.execution.bootstrapReleases.merging([
        origin: VoiceBootstrapRelease(origin: origin, lastFailure: failure)
      ]) { _, new in new }))
    return reserveVoice(retained, .sleep(milliseconds: 500, purpose: .bootstrapCleanup(origin)))
  }
}
