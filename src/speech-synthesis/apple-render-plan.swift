import Foundation
import NaturalLanguage

struct RenderPlanVoice: Codable, Equatable, Sendable {
  let id: String
  let actualLocale: String
}
struct RenderPlanRequest: Decodable {
  let text: String
  let voiceId: String
  let allowedVoices: [RenderPlanVoice]
}
struct RenderPlanRun: Encodable, Equatable {
  let text: String
  let voiceId: String
  let actualLocale: String
}
struct RenderPlan: Encodable {
  let runs: [RenderPlanRun]
}
struct RenderLanguageEstimate {
  let language: String
  let confidence: Double
}
enum RenderPlanningError: Error {
  case invalidRequest, missingInstalledVoice, uncertainLanguage, unsupportedLanguage
}

// This is a private pronunciation plan, never source language annotations.
// Script changes find candidate boundaries; unconstrained NaturalLanguage
// estimation selects a configured voice rather than equating script with language.
struct AppleRenderPlanner {
  private let voices: [RenderPlanVoice]
  private let fallback: RenderPlanVoice
  private let estimate: (String) -> RenderLanguageEstimate?
  private let scripts: [(String, NSRegularExpression)]

  init(
    request: RenderPlanRequest, installedLocale: (String) -> String?,
    estimate: @escaping (String) -> RenderLanguageEstimate? = AppleRenderPlanner.estimateLanguage
  ) throws {
    guard !request.text.isEmpty, request.text.utf16.count <= 800,
      (1...32).contains(request.allowedVoices.count),
      Set(request.allowedVoices.map(\.id)).count == request.allowedVoices.count,
      let fallback = request.allowedVoices.first(where: { $0.id == request.voiceId })
    else {
      throw RenderPlanningError.invalidRequest
    }
    for voice in request.allowedVoices {
      guard !voice.id.isEmpty, voice.id.utf16.count <= 256,
        !voice.actualLocale.isEmpty, voice.actualLocale.utf16.count <= 128,
        installedLocale(voice.id) == voice.actualLocale
      else {
        throw RenderPlanningError.missingInstalledVoice
      }
    }
    self.voices = request.allowedVoices
    self.fallback = fallback
    self.estimate = estimate
    self.scripts = try [
      ("Latn", "\\p{Latin}"), ("Cyrl", "\\p{Cyrillic}"),
      ("Grek", "\\p{Greek}"), ("Arab", "\\p{Arabic}"),
      ("Hebr", "\\p{Hebrew}"), ("Jpan", "[\\p{Han}\\p{Hiragana}\\p{Katakana}]"),
      ("Kore", "\\p{Hangul}"), ("Deva", "\\p{Devanagari}"),
    ].map { ($0.0, try NSRegularExpression(pattern: $0.1)) }
  }
  func plan(_ text: String) throws -> RenderPlan {
    guard !text.isEmpty, text.utf16.count <= 800 else { throw RenderPlanningError.invalidRequest }
    var pieces: [(String, String?)] = []
    var pending = ""
    var family: String?
    for character in text {
      let next = script(character)
      if let next, let family, next != family {
        pieces.append((pending, family))
        pending = ""
      }
      if let next { family = next }
      pending.append(character)
    }
    if !pending.isEmpty { pieces.append((pending, family)) }
    var runs: [RenderPlanRun] = []
    for (piece, family) in pieces {
      let selected = try voice(piece, family: family)
      if let last = runs.last, last.voiceId == selected.id {
        runs[runs.count - 1] = RenderPlanRun(
          text: last.text + piece,
          voiceId: selected.id, actualLocale: selected.actualLocale)
      } else {
        runs.append(
          RenderPlanRun(text: piece, voiceId: selected.id, actualLocale: selected.actualLocale))
      }
    }
    guard !runs.isEmpty, runs.count <= 800,
      runs.map(\.text).joined().utf16.elementsEqual(text.utf16)
    else {
      throw RenderPlanningError.invalidRequest
    }
    return RenderPlan(runs: runs)
  }
  private func voice(_ text: String, family: String?) throws -> RenderPlanVoice {
    guard let family else { return fallback }
    let fallbackScript = Locale.Language(identifier: fallback.actualLocale).script?.identifier
    // Same-script FR/EN ambiguity retains the requested voice. For Latin
    // insertions in a non-Latin reply, ambiguous names retain that voice.
    if family == "Latn", fallbackScript == "Latn" { return fallback }
    let result = estimate(text)
    if family == "Latn" {
      guard let result, result.confidence.isFinite, (0.75...1).contains(result.confidence),
        let selected = voices.first(where: {
          Locale.Language(identifier: $0.actualLocale).languageCode?.identifier == result.language
        })
      else { return fallback }
      return selected
    }
    guard let result, result.confidence.isFinite,
      (0.75...1).contains(result.confidence)
    else {
      if family == fallbackScript { return fallback }
      throw RenderPlanningError.uncertainLanguage
    }
    guard
      let selected = voices.first(where: {
        Locale.Language(identifier: $0.actualLocale).languageCode?.identifier == result.language
      })
    else { throw RenderPlanningError.unsupportedLanguage }
    return selected
  }
  private func script(_ character: Character) -> String? {
    guard
      character.unicodeScalars.contains(where: { scalar in
        switch scalar.properties.generalCategory {
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter:
          true
        default: false
        }
      })
    else { return nil }
    let string = String(character)
    let range = NSRange(location: 0, length: string.utf16.count)
    return scripts.first(where: { $0.1.firstMatch(in: string, range: range) != nil })?.0 ?? "Other"
  }
  static func estimateLanguage(_ text: String) -> RenderLanguageEstimate? {
    let recognizer = NLLanguageRecognizer()
    recognizer.processString(text)
    guard
      let winner = recognizer.languageHypotheses(withMaximum: 4).sorted(by: {
        $0.value == $1.value ? $0.key.rawValue < $1.key.rawValue : $0.value > $1.value
      }).first
    else { return nil }
    return RenderLanguageEstimate(language: winner.key.rawValue, confidence: winner.value)
  }
}
