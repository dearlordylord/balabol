import Foundation

#if canImport(Conversation)
  import Conversation
#endif

public struct VoiceState: Equatable, Sendable {
  public enum Capture: Equatable, Sendable {
    case idle, requestingMicrophone, connecting, listening, muted, ending, ended
    case failed(VoiceFailure)
  }
  public enum Admission: Equatable, Sendable {
    case saving(deliveryId: UUID, text: String)
    case checking(deliveryId: UUID, text: String)
    case saved(ConversationMessage)
    case failed(text: String, VoiceFailure)
  }
  public internal(set) var capture: Capture = .idle
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
  public var isChangingMute: Bool { muteInFlight }
  public var canStart: Bool {
    switch capture {
    case .idle, .ended, .failed: return !hasPendingAdmission
    default: return false
    }
  }
  public var hasPendingAdmission: Bool {
    admissions.values.contains { value in
      switch value {
      case .saving, .checking: true
      default: false
      }
    }
  }
}

enum VoiceEvent {
  case snapshot(Int, VoiceSnapshot)
  case start
  case permission(Int, Bool)
  case bootstrapped(Int, UUID)
  case connected(Int, UUID)
  case failed(Int, VoiceFailure)
  case end
  case ended(Int)
  case mute
  case muted(Int, Bool)
  case wire(Int, VoiceWireEvent)
  case observationFailed(Int)
}
enum VoiceCommand {
  case begin(Int)
  case cancelStart
  case disconnect(Int, UUID?)
  case setMuted(Int, UUID, Bool)
  case observe(Int, UUID)
  case accepted(ConversationMessage)
}

extension VoiceState {
  private mutating func markChecking() {
    for (id, value) in admissions {
      if case .saving(let delivery, let text) = value {
        admissions[id] = .checking(deliveryId: delivery, text: text)
      }
    }
  }
  mutating func transition(_ event: VoiceEvent) -> [VoiceCommand] {
    switch event {
    case .snapshot(let id, let page):
      guard id == generation, page.sessionId == sessionId else { return [] }
      let current = Set(page.pending.map(\.utteranceId))
      utterances.removeAll { id in
        guard !current.contains(id) else { return false }
        switch admissions[id] {
        case .saved, .failed:
          admissions.removeValue(forKey: id)
          return true
        default: return false
        }
      }
      var commands: [VoiceCommand] = []
      if sequence < page.firstSequence - 1 { sequence = page.firstSequence - 1 }
      for pending in page.pending where pending.isValid {
        if tentativeUtterance == pending.utteranceId {
          tentative = ""
          tentativeUtterance = nil
        }
        if !utterances.contains(pending.utteranceId) { utterances.append(pending.utteranceId) }
        if let receipt = pending.receipt {
          if admissions[pending.utteranceId] != .saved(receipt) {
            admissions[pending.utteranceId] = .saved(receipt)
            commands.append(.accepted(receipt))
          }
        } else if let error = pending.error {
          admissions[pending.utteranceId] =
            error.code == "StorageUnavailable"
            ? .checking(deliveryId: pending.deliveryId, text: pending.text)
            : .failed(text: pending.text, .backend(code: error.code, message: error.message))
        } else {
          admissions[pending.utteranceId] =
            capture == .listening || capture == .muted
            ? .saving(deliveryId: pending.deliveryId, text: pending.text)
            : .checking(deliveryId: pending.deliveryId, text: pending.text)
        }
      }
      return commands
    case .start:
      guard canStart else { return [] }
      generation += 1
      sessionId = nil
      sequence = 0
      tentative = ""
      admissions = [:]
      utterances = []
      muteInFlight = false
      tentativeUtterance = nil
      capture = .requestingMicrophone
      return [.begin(generation)]
    case .permission(let id, let allowed):
      guard id == generation, capture == .requestingMicrophone else { return [] }
      capture = allowed ? .connecting : .failed(.permissionDenied)
      return []
    case .bootstrapped(let id, let session):
      guard id == generation, capture == .connecting else { return [] }
      sessionId = session
      return []
    case .connected(let id, let session):
      guard id == generation, capture == .connecting, sessionId == session else { return [] }
      capture = .listening
      return [.observe(id, session)]
    case .failed(let id, let error):
      guard id == generation, capture != .ending, capture != .ended else { return [] }
      capture = .failed(error)
      muteInFlight = false
      tentativeUtterance = nil
      markChecking()
      tentative = ""
      return [.cancelStart, .disconnect(id, sessionId)]
    case .end:
      guard capture != .idle, capture != .ending, capture != .ended else { return [] }
      capture = .ending
      muteInFlight = false
      tentativeUtterance = nil
      tentative = ""
      markChecking()
      return [.cancelStart, .disconnect(generation, sessionId)]
    case .ended(let id):
      guard id == generation, capture == .ending else { return [] }
      capture = .ended
      return []
    case .mute:
      guard !muteInFlight, let sessionId, capture == .listening || capture == .muted else {
        return []
      }
      muteInFlight = true
      return [.setMuted(generation, sessionId, capture == .listening)]
    case .muted(let id, let value):
      guard id == generation, capture == .listening || capture == .muted else { return [] }
      muteInFlight = false
      capture = value ? .muted : .listening
      if value {
        tentative = ""
        tentativeUtterance = nil
      }
      return []
    case .observationFailed(let id):
      guard id == generation else { return [] }
      markChecking()
      if capture == .listening || capture == .muted {
        capture = .failed(.connection)
        muteInFlight = false
        tentativeUtterance = nil
        tentative = ""
        return [.disconnect(id, sessionId)]
      }
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
        guard capture == .listening || capture == .muted || capture == .ending || capture == .ended,
          let delivery = wire.deliveryId, let text = wire.text
        else { return [] }
        if tentativeUtterance == wire.utteranceId {
          tentative = ""
          tentativeUtterance = nil
        }
        guard let utterance = wire.utteranceId, admissions[utterance] == nil else { return [] }
        utterances.removeAll { id in
          switch admissions[id] {
          case .saved, .failed:
            admissions.removeValue(forKey: id)
            return true
          default: return false
          }
        }
        utterances.append(utterance)
        admissions[utterance] =
          capture == .ending || capture == .ended
          ? .checking(deliveryId: delivery, text: text)
          : .saving(deliveryId: delivery, text: text)
      case "Discarded":
        if wire.utteranceId == tentativeUtterance {
          tentative = ""
          tentativeUtterance = nil
        }
      case "Accepted":
        guard let utterance = wire.utteranceId, let receipt = wire.receipt else { return [] }
        let expected: UUID?
        switch admissions[utterance] {
        case .saving(let id, let text), .checking(let id, let text):
          expected = receipt.text == text ? id : nil
        default: expected = nil
        }
        guard receipt.deliveryId == expected else { return [] }
        admissions[utterance] = .saved(receipt)
        return [.accepted(receipt)]
      case "Error":
        let failure = VoiceFailure.backend(code: wire.code ?? "", message: wire.message ?? "")
        if let utterance = wire.utteranceId, let admission = admissions[utterance] {
          switch admission {
          case .saving(let delivery, let text), .checking(let delivery, let text):
            admissions[utterance] =
              wire.code == "StorageUnavailable"
              ? .checking(deliveryId: delivery, text: text) : .failed(text: text, failure)
          default: break
          }
        } else if capture == .listening || capture == .muted {
          capture = .failed(failure)
          muteInFlight = false
          tentative = ""
          tentativeUtterance = nil
          markChecking()
          return [.disconnect(id, sessionId)]
        }
      case "Ended":
        tentative = ""
        tentativeUtterance = nil
        muteInFlight = false
        if capture == .listening || capture == .muted {
          capture = .ending
          return [.disconnect(id, sessionId)]
        }
      default: break
      }
      return []
    }
  }
}
