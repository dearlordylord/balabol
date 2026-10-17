import Foundation

#if canImport(Conversation)
  import Conversation
#endif

internal struct VoiceLanguageState: Equatable, Sendable {
  let languages: VoiceLanguages?
  let failure: VoiceFailure?
  init(
    languages: VoiceLanguages? = nil,
    failure: VoiceFailure? = nil
  ) {
    self.languages = languages
    self.failure = failure
  }
  func replacing(
    languages: VoiceLanguages?? = nil,
    failure: VoiceFailure?? = nil
  ) -> VoiceLanguageState {
    VoiceLanguageState(
      languages: languages ?? self.languages,
      failure: failure ?? self.failure
    )
  }
}
