import Foundation

#if canImport(Conversation)
  import Conversation
#endif

internal struct VoiceAdmissionState: Equatable, Sendable {
  let recentAcceptedAdmissions: [VoiceAcceptedAdmission]
  let associations: [UUID: VoiceAdmissionAssociation]
  let stagedFinals: [UUID: String]
  let checkpointRevision: Int
  let checkpointSavedRevision: Int
  let checkpointFailureRevision: Int?
  let checkpointLoaded: Bool
  let admissionFailure: VoiceFailure?
  let admissionLanguageSpans: [UUID: [LanguageSpan]]
  let admissions: [UUID: VoiceState.Admission]
  let utterances: [UUID]
  init(
    recentAcceptedAdmissions: [VoiceAcceptedAdmission] = [],
    associations: [UUID: VoiceAdmissionAssociation] = [:],
    stagedFinals: [UUID: String] = [:],
    checkpointRevision: Int = 0,
    checkpointSavedRevision: Int = 0,
    checkpointFailureRevision: Int? = nil,
    checkpointLoaded: Bool = false,
    admissionFailure: VoiceFailure? = nil,
    admissionLanguageSpans: [UUID: [LanguageSpan]] = [:],
    admissions: [UUID: VoiceState.Admission] = [:],
    utterances: [UUID] = []
  ) {
    self.recentAcceptedAdmissions = recentAcceptedAdmissions
    self.associations = associations
    self.stagedFinals = stagedFinals
    self.checkpointRevision = checkpointRevision
    self.checkpointSavedRevision = checkpointSavedRevision
    self.checkpointFailureRevision = checkpointFailureRevision
    self.checkpointLoaded = checkpointLoaded
    self.admissionFailure = admissionFailure
    self.admissionLanguageSpans = admissionLanguageSpans
    self.admissions = admissions
    self.utterances = utterances
  }
  func replacing(
    recentAcceptedAdmissions: [VoiceAcceptedAdmission]? = nil,
    associations: [UUID: VoiceAdmissionAssociation]? = nil,
    stagedFinals: [UUID: String]? = nil,
    checkpointRevision: Int? = nil,
    checkpointSavedRevision: Int? = nil,
    checkpointFailureRevision: Int?? = nil,
    checkpointLoaded: Bool? = nil,
    admissionFailure: VoiceFailure?? = nil,
    admissionLanguageSpans: [UUID: [LanguageSpan]]? = nil,
    admissions: [UUID: VoiceState.Admission]? = nil,
    utterances: [UUID]? = nil
  ) -> VoiceAdmissionState {
    VoiceAdmissionState(
      recentAcceptedAdmissions: recentAcceptedAdmissions ?? self.recentAcceptedAdmissions,
      associations: associations ?? self.associations,
      stagedFinals: stagedFinals ?? self.stagedFinals,
      checkpointRevision: checkpointRevision ?? self.checkpointRevision,
      checkpointSavedRevision: checkpointSavedRevision ?? self.checkpointSavedRevision,
      checkpointFailureRevision: checkpointFailureRevision ?? self.checkpointFailureRevision,
      checkpointLoaded: checkpointLoaded ?? self.checkpointLoaded,
      admissionFailure: admissionFailure ?? self.admissionFailure,
      admissionLanguageSpans: admissionLanguageSpans ?? self.admissionLanguageSpans,
      admissions: admissions ?? self.admissions,
      utterances: utterances ?? self.utterances
    )
  }
}

internal struct VoiceAcceptedAdmission: Equatable, Sendable {
  let association: VoiceAdmissionAssociation
  let receipt: ConversationMessage
}
