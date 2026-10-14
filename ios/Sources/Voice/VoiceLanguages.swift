import Foundation

#if canImport(Conversation)
  import Conversation
#endif

/// Read-only host configuration. Provider capability validation belongs to the
/// host; this projection never silently filters or changes the configured set.
public struct VoiceLanguages: Decodable, Equatable, Sendable {
  public let allowedLanguages: [String]
  public let supportedLanguages: [String]
  public var isValid: Bool {
    valid(allowedLanguages) && valid(supportedLanguages)
      && Set(allowedLanguages).isSubset(of: Set(supportedLanguages))
  }
  private func valid(_ values: [String]) -> Bool {
    !values.isEmpty && values.count <= 32 && Set(values).count == values.count
      && values.allSatisfy(LanguageSpan.isValidLanguageTag)
  }
  public func displayNames(locale: Locale = .current) -> String {
    allowedLanguages.map { locale.localizedString(forIdentifier: $0) ?? $0 }
      .joined(separator: " · ")
  }
}
