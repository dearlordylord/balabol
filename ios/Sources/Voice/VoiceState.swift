import Foundation

#if canImport(Conversation)
  import Conversation
#endif

public struct VoiceState: Equatable, Sendable {
  public enum Capture: Equatable, Sendable {
    case idle, requestingMicrophone, connecting, reconnecting, hostUnavailable,
      checkingPreviousSpeech, listening, muted, paused, resuming, ending, ended
    case failed(VoiceFailure)
  }
  public enum Admission: Equatable, Sendable {
    case saving(deliveryId: UUID, text: String)
    case checking(deliveryId: UUID, text: String)
    case saved(ConversationMessage)
    case failed(text: String, VoiceFailure)
  }
  public enum Intent: Equatable, Sendable {
    case off
    case listening(muted: Bool)
  }
  public internal(set) var intent: Intent = .off
  public internal(set) var capture: Capture = .idle
  internal var startRequestId = UUID()
  internal var startMuted = false
  internal var bootstrapKnown = false
  internal var retryStep = 0
  internal var backendIncarnationId: UUID?
  internal struct AcceptedAdmission: Equatable, Sendable {
    let association: VoiceAdmissionAssociation
    let receipt: ConversationMessage
  }
  internal var recentAcceptedAdmissions: [AcceptedAdmission] = []
  internal var snapshotSequence = -1
  internal var associations: [UUID: VoiceAdmissionAssociation] = [:]
  internal var stagedFinals: [UUID: String] = [:]
  internal var checkpointRevision = 0
  internal var checkpointLoaded = false
  internal var isRetired = false
  public internal(set) var admissionFailure: VoiceFailure?
  public var wantsListening: Bool {
    if case .listening = intent { return true }
    return false
  }
  public var wantsMuted: Bool {
    if case .listening(let muted) = intent { return muted }
    return false
  }
  public var canSwitchServer: Bool {
    checkpointLoaded && !isRetired && !wantsListening && !hasPendingAdmission
      && associations.isEmpty
  }
  public internal(set) var languages: VoiceLanguages?
  public internal(set) var languageFailure: VoiceFailure?
  internal var languageRequest: UUID?
  public internal(set) var admissionLanguageSpans: [UUID: [LanguageSpan]] = [:]
  public internal(set) var tentative = ""
  public internal(set) var admissions: [UUID: Admission] = [:]
  public internal(set) var utterances: [UUID] = []
  public var admission: Admission? { utterances.last.flatMap { admissions[$0] } }
  internal var generation = 0
  internal var sessionId: UUID?
  internal var sequence = 0
  internal var tentativeUtterance: UUID?
  internal var muteInFlight = false
  public init() {}
  internal var isConnecting: Bool { capture == .connecting || capture == .resuming }
  internal var resumeProbe = false
  internal var drainingSession: UUID?
  internal var drainingIncarnation: UUID?
  public var canResume: Bool { capture == .paused && wantsListening }
  public var isChangingMute: Bool { muteInFlight }
  public var canStart: Bool {
    switch capture {
    case .idle, .ended, .failed: return !wantsListening
    default: return false
    }
  }
  public var hasPendingAdmission: Bool {
    !associations.isEmpty
      || admissions.values.contains { value in
        switch value {
        case .saving, .checking: true
        default: false
        }
      }
  }
}

enum VoiceEvent {
  case loadLanguages
  case languagesLoaded(UUID, Result<VoiceLanguages, VoiceFailure>)
  case snapshot(Int, VoiceSnapshot)
  case start
  case platform(VoicePlatformEvent)
  case drainedSession(VoiceSnapshot)
  case producerUnavailable(UUID, UUID)
  case sealFailed(UUID)
  case resume
  case shutdown
  case permission(Int, Bool)
  case bootstrapped(Int, UUID, UUID)
  case connected(Int, UUID, Bool)
  case failed(Int, VoiceFailure)
  case end
  case ended(Int)
  case mute
  case muted(Int, Bool)
  case wire(Int, VoiceWireEvent)
  case observationFailed(Int, VoiceFailure)
  case retryReady(Int)
  case restored([VoiceAdmissionAssociation])
  case checkpointSaved(Int)
  case checkpointFailed(Int)
  case resolved([VoiceAdmissionAssociation], VoiceAdmissionResolution)
  case resolutionFailed(VoiceFailure)
}
enum VoiceCommand {
  case loadLanguages(UUID)
  case refreshLanguages
  case begin(Int)
  case cancelStart
  case disconnect(Int, UUID?)
  case setMuted(Int, UUID, Bool)
  case observe(Int, UUID)
  case accepted(ConversationMessage)
  case retry(Int, Int)
  case cancelRetry
  case cancelProducers
  case checkpoint(Int, [VoiceAdmissionAssociation])
  case resolve([VoiceAdmissionAssociation])
  case refreshConversation
  case interruptHandedInputs([UUID])
  case platformFence([UUID])
  case cutOutput
  case retirePlatformObservation
}

extension VoiceState {
  internal mutating func markChecking() {
    for (id, value) in admissions {
      if case .saving(let delivery, let text) = value {
        admissions[id] = .checking(deliveryId: delivery, text: text)
      }
    }
  }
  mutating func transition(_ event: VoiceEvent) -> [VoiceCommand] {
    if isRetired {
      switch event {
      case .ended: break
      default: return []
      }
    }
    switch event {
    case .platform, .resume, .drainedSession, .sealFailed, .producerUnavailable:
      return platformTransition(event)
    case .loadLanguages:
      guard languageRequest == nil else { return [] }
      let request = UUID()
      languageRequest = request
      return [.loadLanguages(request)]
    case .languagesLoaded(let request, let result):
      guard languageRequest == request else { return [] }
      languageRequest = nil
      switch result {
      case .success(let value):
        guard value.isValid else {
          languages = nil
          languageFailure = .invalidResponse
          return []
        }
        languages = value
        languageFailure = nil
      case .failure(let failure):
        languages = nil
        languageFailure = failure
      }
      return []
    case .shutdown:
      let commands = transition(.end)
      isRetired = true
      return commands + [.cancelProducers]
    case .retryReady, .restored, .checkpointSaved, .checkpointFailed, .resolved, .resolutionFailed:
      return recoveryTransition(event)
    case .snapshot(let id, let page):
      guard id == generation, page.sessionId == sessionId,
        page.backendIncarnationId == backendIncarnationId, page.sequence >= snapshotSequence
      else { return [] }
      snapshotSequence = page.sequence
      var commands: [VoiceCommand] = []
      if sequence < page.firstSequence - 1 { sequence = page.firstSequence - 1 }
      for pending in page.pending
      where pending.isValid && pending.backendIncarnationId == page.backendIncarnationId {
        let association = VoiceAdmissionAssociation(
          backendIncarnationId: pending.backendIncarnationId,
          sessionId: page.sessionId, deliveryId: pending.deliveryId,
          detectedLanguage: pending.detectedLanguage)
        if let receipt = pending.receipt {
          commands += acceptedAdmission(association, receipt: receipt, expectedText: pending.text)
        } else {
          commands += stageFinal(
            association, text: pending.text, languageSpans: pending.languageSpans)
        }
      }
      if page.status == "ended", wantsListening { commands += transportFailed(.connection) }
      return commands
    case .start:
      guard canStart else { return [] }
      generation += 1
      sessionId = nil
      sequence = 0
      snapshotSequence = -1
      tentative = ""
      intent = .listening(muted: false)
      startRequestId = UUID()
      startMuted = hasPendingAdmission
      bootstrapKnown = false
      retryStep = 0
      muteInFlight = false
      tentativeUtterance = nil
      capture = .requestingMicrophone
      return [.begin(generation)]
    case .permission(let id, let allowed):
      guard id == generation,
        capture == .requestingMicrophone || capture == .reconnecting || capture == .resuming
      else {
        return []
      }
      capture = allowed ? (resumeProbe ? .resuming : .connecting) : .failed(.permissionDenied)
      if !allowed { intent = .off }
      return []
    case .bootstrapped(let id, let session, let incarnation):
      guard id == generation, isConnecting else { return [] }
      sessionId = session
      backendIncarnationId = incarnation
      bootstrapKnown = true
      return []
    case .connected(let id, let session, let actuallyMuted):
      guard id == generation, isConnecting, sessionId == session, wantsListening else {
        return []
      }
      retryStep = 0
      resumeProbe = false
      capture =
        hasPendingAdmission ? .checkingPreviousSpeech : (actuallyMuted ? .muted : .listening)
      var commands: [VoiceCommand] = [
        .observe(id, session), .refreshConversation, .refreshLanguages,
      ]
      let desiredMute = wantsMuted || hasPendingAdmission
      if actuallyMuted != desiredMute || startMuted != desiredMute {
        muteInFlight = true
        commands.append(.setMuted(id, session, desiredMute))
      }
      return commands
    case .failed(let id, let error):
      guard id == generation, capture != .ending, capture != .ended else { return [] }
      return transportFailed(error)
    case .end:
      guard capture != .idle, capture != .ending, capture != .ended else { return [] }
      intent = .off
      capture = .ending
      muteInFlight = false
      tentativeUtterance = nil
      tentative = ""
      markChecking()
      var commands: [VoiceCommand] = [
        .cutOutput, .retirePlatformObservation, .cancelRetry, .cancelStart,
        .disconnect(generation, sessionId),
      ]
      if !associations.isEmpty, stagedFinals.isEmpty {
        commands.append(.resolve(pendingAssociations))
      }
      return commands
    case .ended(let id):
      guard id == generation, capture == .ending else { return [] }
      capture = .ended
      return []
    case .mute:
      guard wantsListening, !muteInFlight else { return [] }
      intent = .listening(muted: !wantsMuted)
      if isConnecting, bootstrapKnown { return transportFailed(.connection) }
      guard let sessionId, capture == .listening || capture == .muted else { return [] }
      muteInFlight = true
      return [.setMuted(generation, sessionId, wantsMuted)]
    case .muted(let id, let value):
      guard id == generation, wantsListening,
        capture == .listening || capture == .muted || capture == .checkingPreviousSpeech
      else { return [] }
      muteInFlight = false
      capture = hasPendingAdmission ? .checkingPreviousSpeech : (value ? .muted : .listening)
      if value {
        tentative = ""
        tentativeUtterance = nil
      }
      return []
    case .observationFailed(let id, let error):
      guard id == generation else { return [] }
      if wantsListening { return transportFailed(error) }
      markChecking()
      return []
    case .wire(let id, let wire):
      guard id == generation, wire.sessionId == sessionId, wire.sequence > sequence, wire.isValid
      else { return [] }
      sequence = wire.sequence
      switch wire.kind {
      case "Interim":
        if capture == .listening {
          tentative = wire.text ?? ""
          tentativeUtterance = wire.utteranceId
        }
      case "Final":
        guard let delivery = wire.deliveryId, let text = wire.text,
          let incarnation = wire.backendIncarnationId,
          incarnation == backendIncarnationId
        else { return [] }
        if tentativeUtterance == wire.utteranceId {
          tentative = ""
          tentativeUtterance = nil
        }
        return stageFinal(
          VoiceAdmissionAssociation(
            backendIncarnationId: incarnation,
            sessionId: wire.sessionId, deliveryId: delivery, detectedLanguage: wire.detectedLanguage
          ), text: text,
          languageSpans: wire.languageSpans ?? [])
      case "Discarded":
        if wire.utteranceId == tentativeUtterance {
          tentative = ""
          tentativeUtterance = nil
        }
      case "Accepted":
        guard let receipt = wire.receipt, let association = associations[receipt.deliveryId] else {
          return []
        }
        let expectedText = stagedFinals[receipt.deliveryId] ?? admissionText(receipt.deliveryId)
        return acceptedAdmission(association, receipt: receipt, expectedText: expectedText)
      case "Error":
        let failure = VoiceFailure.backend(code: wire.code ?? "", message: wire.message ?? "")
        if let utterance = wire.utteranceId, let association = associations[utterance] {
          if let text = admissionText(utterance) {
            admissions[utterance] = .checking(deliveryId: association.deliveryId, text: text)
          }
          return [.resolve(pendingAssociations)]
        } else if capture == .listening || capture == .muted {
          return transportFailed(failure)
        }
      case "Ended":
        tentative = ""
        tentativeUtterance = nil
        muteInFlight = false
        if wantsListening { return transportFailed(.connection) }
      default: break
      }
      return []
    }
  }
}

/// Platform observations describe availability; only user Resume authorizes a
/// fresh SDK-owned probe. A recommendation never reopens capture or old output.
public enum VoicePlatformEvent: Equatable, Sendable {
  case interrupted
  case resumeRecommended(Bool)
  case routeChanged(privateOutputRemoved: Bool)
  case servicesLost, servicesReset
}

extension VoiceState {
  mutating func platformTransition(_ event: VoiceEvent) -> [VoiceCommand] {
    switch event {
    case .drainedSession, .producerUnavailable: break
    default: guard wantsListening else { return [] }
    }
    switch event {
    case .producerUnavailable(let session, let incarnation):
      guard session == drainingSession, incarnation == drainingIncarnation else { return [] }
      drainingSession = nil
      drainingIncarnation = nil
      // Closure authorizes a fresh producer only. Known admissions retain their
      // exact association and checkpoint; absence never means NotAccepted.
      return []
    case .sealFailed(let session):
      guard session == drainingSession else { return [] }
      capture = .paused
      resumeProbe = false
      return [.cancelStart]
    case .drainedSession(let page):
      guard page.sessionId == drainingSession, page.backendIncarnationId == drainingIncarnation
      else { return [] }
      guard page.status == "ended" else { return platformTransition(.sealFailed(page.sessionId)) }
      drainingSession = nil
      drainingIncarnation = nil
      var commands: [VoiceCommand] = []
      for pending in page.pending
      where pending.isValid && pending.backendIncarnationId == page.backendIncarnationId {
        let association = VoiceAdmissionAssociation(
          backendIncarnationId: pending.backendIncarnationId, sessionId: page.sessionId,
          deliveryId: pending.deliveryId, detectedLanguage: pending.detectedLanguage)
        if let receipt = pending.receipt {
          commands += acceptedAdmission(association, receipt: receipt, expectedText: pending.text)
        } else {
          commands += stageFinal(
            association, text: pending.text, languageSpans: pending.languageSpans)
        }
      }
      if !bootstrapKnown { startMuted = wantsMuted || hasPendingAdmission }
      let handed = page.pending.filter(\.isValid).map(\.deliveryId)
      if !handed.isEmpty { commands.append(.interruptHandedInputs(Array(handed.prefix(2)))) }
      return commands
    case .resume:
      guard canResume else { return [] }
      generation += 1
      startRequestId = UUID()
      startMuted = wantsMuted || hasPendingAdmission
      bootstrapKnown = false
      sessionId = nil
      backendIncarnationId = nil
      sequence = 0
      snapshotSequence = -1
      resumeProbe = true
      capture = .resuming
      var commands: [VoiceCommand] = []
      if let drainingSession { commands.append(.disconnect(generation, drainingSession)) }
      commands.append(.begin(generation))
      return commands
    case .platform(let value):
      switch value {
      case .resumeRecommended, .servicesReset:
        return []
      case .routeChanged(false): return []
      case .interrupted, .servicesLost, .routeChanged(true):
        guard capture != .paused, capture != .ending, capture != .ended else { return [] }
        let oldSession = sessionId
        drainingSession = oldSession
        drainingIncarnation = backendIncarnationId
        sessionId = nil
        backendIncarnationId = nil
        generation += 1
        capture = .paused
        resumeProbe = false
        muteInFlight = false
        tentative = ""
        tentativeUtterance = nil
        markChecking()
        var commands: [VoiceCommand] = [
          .platformFence(pendingAssociations.map(\.deliveryId)), .cancelRetry, .cancelStart,
          .disconnect(generation, oldSession),
        ]
        if !associations.isEmpty, stagedFinals.isEmpty {
          commands.append(.resolve(pendingAssociations))
        }
        return commands
      }
    default: return []
    }
  }
}

/// Notification delivery is independent of the RTC room lifetime. A capture
/// epoch rejects notices queued before mute, pause or a new recovery attempt.
internal struct VoicePlatformEpoch: Sendable {
  private(set) var identity = UUID()
  mutating func advance(to identity: UUID) { self.identity = identity }
  func accepts(_ identity: UUID) -> Bool { self.identity == identity }
}
