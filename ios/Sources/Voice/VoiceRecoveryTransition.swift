import Foundation

extension VoiceState {
  private var retryDelays: [Int] { [500, 1000, 2000, 4000, 8000] }
  internal mutating func transportFailed(_ error: VoiceFailure) -> [VoiceCommand] {
    muteInFlight = false
    tentative = ""
    tentativeUtterance = nil
    markChecking()
    let oldSession = sessionId
    if capture == .paused || resumeProbe {
      if let sessionId {
        drainingSession = sessionId
        drainingIncarnation = backendIncarnationId
      }
      generation += 1
      capture = .paused
      resumeProbe = false
      return [.cancelRetry, .cancelStart, .disconnect(generation, oldSession)]
    }
    let retryable: Bool
    switch error {
    case .connection: retryable = true
    case .backend(let code, _):
      retryable = [
        "SessionNotFound", "StartExpired", "VoiceBusy", "Unavailable", "StorageUnavailable",
      ].contains(
        code)
    default: retryable = false
    }
    if retryable, wantsListening {
      capture = error.isVoiceBusy ? .reconnecting : .hostUnavailable
      if bootstrapKnown || error.isExpiredStart {
        startRequestId = UUID()
        startMuted = wantsMuted || hasPendingAdmission
        bootstrapKnown = false
      }
      generation += 1
      sessionId = nil
      backendIncarnationId = nil
      sequence = 0
      snapshotSequence = -1
      let delay = retryDelays[min(retryStep, retryDelays.count - 1)]
      retryStep = min(retryStep + 1, retryDelays.count - 1)
      var commands: [VoiceCommand] = [
        .cancelStart, .disconnect(generation, oldSession), .retry(generation, delay),
      ]
      if !associations.isEmpty, stagedFinals.isEmpty {
        commands.append(.resolve(pendingAssociations))
      }
      return commands
    }
    intent = .off
    capture = .failed(error)
    return [.cancelRetry, .cancelStart, .disconnect(generation, oldSession)]
  }
  internal mutating func recoveryTransition(_ event: VoiceEvent) -> [VoiceCommand] {
    switch event {
    case .retryReady(let id):
      guard id == generation, wantsListening, [.hostUnavailable, .reconnecting].contains(capture)
      else { return [] }
      capture = .reconnecting
      return [.begin(id)]
    case .restored(let values):
      checkpointLoaded = true
      for value in values.prefix(2) {
        associations[value.deliveryId] = value
        if admissions[value.deliveryId] == nil {
          admissions[value.deliveryId] = .checking(deliveryId: value.deliveryId, text: "")
          utterances.append(value.deliveryId)
        }
      }
      if !bootstrapKnown { startMuted = wantsMuted || hasPendingAdmission }
      return values.isEmpty ? [] : [.resolve(values)]
    case .checkpointSaved(let revision):
      guard revision == checkpointRevision else { return [] }
      admissionFailure = nil
      for (id, text) in stagedFinals {
        if !utterances.contains(id) { utterances.append(id) }
        admissions[id] =
          wantsListening
          ? .saving(deliveryId: id, text: text) : .checking(deliveryId: id, text: text)
      }
      stagedFinals = [:]
      let needsResolution =
        !wantsListening || [.hostUnavailable, .reconnecting].contains(capture)
        || capture == .checkingPreviousSpeech || capture == .paused
        || associations.values.contains { $0.sessionId != sessionId }
      return associations.isEmpty || !needsResolution ? [] : [.resolve(pendingAssociations)]
    case .checkpointFailed(let revision):
      guard revision == checkpointRevision else { return [] }
      admissionFailure = .checkpointUnavailable
      return transportFailed(.checkpointUnavailable)
        + (associations.isEmpty ? [] : [.resolve(pendingAssociations)])
    case .resolutionFailed(let failure):
      admissionFailure = failure
      markChecking()
      return []
    case .resolved(let requested, let response):
      guard response.isValid(for: requested) else { return [] }
      admissionFailure = nil
      var commands: [VoiceCommand] = []
      for value in response.admissions
      where associations[value.deliveryId]?.identity == value.association.identity {
        switch value.status {
        case .accepted:
          if let receipt = value.receipt {
            commands += acceptedAdmission(
              value.association, receipt: receipt,
              expectedText: stagedFinals[value.deliveryId] ?? admissionText(value.deliveryId))
          }
        case .notAccepted:
          let text = stagedFinals[value.deliveryId] ?? admissionText(value.deliveryId) ?? ""
          associations.removeValue(forKey: value.deliveryId)
          stagedFinals.removeValue(forKey: value.deliveryId)
          if !utterances.contains(value.deliveryId) { utterances.append(value.deliveryId) }
          admissions[value.deliveryId] = .failed(
            text: text, .backend(code: "NotAccepted", message: "Please repeat the speech"))
          checkpointRevision += 1
          commands.append(.checkpoint(checkpointRevision, pendingAssociations))
          commands += restoreCaptureAfterAdmission()
        case .unknown:
          if let text = admissionText(value.deliveryId) {
            admissions[value.deliveryId] = .checking(deliveryId: value.deliveryId, text: text)
          }
        }
      }
      return commands
    default: return []
    }
  }
}

extension VoiceFailure {
  fileprivate var isVoiceBusy: Bool {
    if case .backend(let code, _) = self { return code == "VoiceBusy" }
    return false
  }
  fileprivate var isExpiredStart: Bool {
    if case .backend(let code, _) = self { return code == "StartExpired" }
    return false
  }
}

#if canImport(Conversation)
  import Conversation
#endif

extension VoiceState {
  private mutating func trimSettledAdmissions() {
    let settled = utterances.filter { associations[$0] == nil && stagedFinals[$0] == nil }
    for id in settled.dropLast(1) {
      admissions.removeValue(forKey: id)
      admissionLanguageSpans.removeValue(forKey: id)
      utterances.removeAll { $0 == id }
    }
  }
  internal var pendingAssociations: [VoiceAdmissionAssociation] {
    associations.values.sorted { $0.deliveryId.uuidString < $1.deliveryId.uuidString }
  }
  internal func admissionText(_ id: UUID) -> String? {
    switch admissions[id] {
    case .saving(_, let text), .checking(_, let text): return text
    default: return nil
    }
  }
  internal mutating func stageFinal(
    _ association: VoiceAdmissionAssociation, text: String,
    languageSpans: [LanguageSpan] = []
  )
    -> [VoiceCommand]
  {
    if let accepted = recentAcceptedAdmissions.first(where: {
      $0.association.identity == association.identity
    }) {
      return accepted.receipt.text == text && accepted.receipt.languageSpans == languageSpans
        && accepted.receipt.detectedLanguage == association.detectedLanguage
        ? [] : transportFailed(.invalidResponse)
    }
    if let known = associations[association.deliveryId] {
      guard known == association,
        stagedFinals[association.deliveryId] == nil || stagedFinals[association.deliveryId] == text,
        admissionLanguageSpans[association.deliveryId] == nil
          || admissionLanguageSpans[association.deliveryId] == languageSpans
      else { return transportFailed(.invalidResponse) }
      return []
    }
    switch admissions[association.deliveryId] {
    case .saved, .failed: return []
    default: break
    }
    guard associations.count < 2 else {
      return transportFailed(
        .backend(code: "AdmissionCapacity", message: "Speech admission tracking is full"))
    }
    trimSettledAdmissions()
    associations[association.deliveryId] = association
    stagedFinals[association.deliveryId] = text
    admissionLanguageSpans[association.deliveryId] = languageSpans
    checkpointRevision += 1
    var commands: [VoiceCommand] = [.checkpoint(checkpointRevision, pendingAssociations)]
    if associations.count == 2, wantsListening, let sessionId, capture == .listening, !muteInFlight
    {
      capture = .checkingPreviousSpeech
      muteInFlight = true
      commands.append(.setMuted(generation, sessionId, true))
    }
    return commands
  }
  internal mutating func acceptedAdmission(
    _ association: VoiceAdmissionAssociation, receipt: ConversationMessage,
    expectedText: String?
  ) -> [VoiceCommand] {
    guard receipt.isValid, receipt.role == .user, receipt.deliveryId == association.deliveryId,
      expectedText == nil || expectedText?.isEmpty == true || expectedText == receipt.text
    else { return [] }
    if let known = associations[association.deliveryId] {
      guard known.identity == association.identity,
        known.detectedLanguage == receipt.detectedLanguage
      else { return [] }
    }
    let association = associations[association.deliveryId] ?? association
    if let accepted = recentAcceptedAdmissions.first(where: {
      $0.association.identity == association.identity
    }) {
      return accepted.receipt == receipt ? [] : transportFailed(.invalidResponse)
    }
    if let spans = admissionLanguageSpans[association.deliveryId], spans != receipt.languageSpans {
      return []
    }
    if admissions[association.deliveryId] == .saved(receipt) { return [] }
    associations.removeValue(forKey: association.deliveryId)
    stagedFinals.removeValue(forKey: association.deliveryId)
    if !utterances.contains(association.deliveryId) { utterances.append(association.deliveryId) }
    admissions[association.deliveryId] = .saved(receipt)
    admissionLanguageSpans[association.deliveryId] = receipt.languageSpans
    // The canonical server page retains at most two finals. Keep their identity
    // fence separate from the single visible settled row; stale pages are also
    // rejected by the session's monotonic snapshot sequence.
    recentAcceptedAdmissions.append(AcceptedAdmission(association: association, receipt: receipt))
    recentAcceptedAdmissions = Array(recentAcceptedAdmissions.suffix(2))
    trimSettledAdmissions()
    checkpointRevision += 1
    return [.accepted(receipt), .checkpoint(checkpointRevision, pendingAssociations)]
      + restoreCaptureAfterAdmission()
  }
  private mutating func restoreCaptureAfterAdmission() -> [VoiceCommand] {
    guard associations.isEmpty, wantsListening, capture == .checkingPreviousSpeech,
      let sessionId, !muteInFlight
    else { return [] }
    if wantsMuted {
      capture = .muted
      return []
    }
    muteInFlight = true
    return [.setMuted(generation, sessionId, false)]
  }
}
