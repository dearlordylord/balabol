import Foundation

/// Server-canonical language metadata annotates UTF-16 text; it never selects
/// a provider or guesses a language from the characters displayed by the phone.
public struct LanguageSpan: Codable, Equatable, Sendable {
  public let language: String
  public let start: Int
  public let end: Int
  public init(language: String, start: Int, end: Int) {
    self.language = language
    self.start = start
    self.end = end
  }
  public static func areValid(_ spans: [LanguageSpan], for text: String) -> Bool {
    guard spans.count <= 1000 else { return false }
    if spans.isEmpty { return true }
    let units = Array(text.utf16)
    var previousEnd = 0
    for span in spans {
      guard isValidLanguageTag(span.language), span.start >= previousEnd,
        span.start < span.end, span.end <= units.count,
        scalarBoundary(span.start, units), scalarBoundary(span.end, units)
      else { return false }
      previousEnd = span.end
    }
    return true
  }
  private static func scalarBoundary(_ offset: Int, _ units: [UInt16]) -> Bool {
    offset == 0 || offset == units.count
      || !(0xD800...0xDBFF).contains(units[offset - 1])
      || !(0xDC00...0xDFFF).contains(units[offset])
  }

  /// Validate bounded BCP47 structure/case while preserving the host's Intl
  /// canonical spelling. Foundation's locale canonicalizer suppresses scripts
  /// and changes Unicode extensions, so it cannot be used as the wire authority.
  public static func isValidLanguageTag(_ tag: String) -> Bool {
    guard !tag.isEmpty, tag.utf8.count <= 64,
      tag.utf8.allSatisfy({
        (48...57).contains($0) || (65...90).contains($0)
          || (97...122).contains($0) || $0 == 45
      })
    else { return false }
    let parts = tag.split(separator: "-", omittingEmptySubsequences: false).map(String.init)
    guard let language = parts.first,
      (2...8).contains(language.count), language.count != 4,
      alphabetic(language), language == language.lowercased()
    else { return false }
    var index = 1
    if language.count <= 3 {
      var extlangs = 0
      while index < parts.count, parts[index].count == 3, alphabetic(parts[index]), extlangs < 3 {
        guard parts[index] == parts[index].lowercased() else { return false }
        index += 1
        extlangs += 1
      }
    }
    if index < parts.count, parts[index].count == 4, alphabetic(parts[index]) {
      let script = parts[index]
      guard script == script.prefix(1).uppercased() + script.dropFirst().lowercased() else {
        return false
      }
      index += 1
    }
    if index < parts.count {
      let region = parts[index]
      if region.count == 2, alphabetic(region) {
        guard region == region.uppercased() else { return false }
        index += 1
      } else if region.count == 3, region.utf8.allSatisfy({ (48...57).contains($0) }) {
        index += 1
      }
    }
    var variants: Set<String> = []
    while index < parts.count, parts[index].count >= 4 {
      let variant = parts[index]
      guard
        (5...8).contains(variant.count)
          || (variant.count == 4 && variant.utf8.first.map({ (48...57).contains($0) }) == true),
        alphanumeric(variant), variant == variant.lowercased(), variants.insert(variant).inserted
      else { return false }
      index += 1
    }
    var extensions: Set<String> = []
    while index < parts.count {
      let singleton = parts[index]
      guard singleton.count == 1, alphanumeric(singleton), singleton == singleton.lowercased(),
        extensions.insert(singleton).inserted
      else { return false }
      index += 1
      let first = index
      while index < parts.count, parts[index].count > (singleton == "x" ? 0 : 1) {
        let value = parts[index]
        guard value.count <= 8, alphanumeric(value), value == value.lowercased() else {
          return false
        }
        index += 1
      }
      guard index > first else { return false }
      if singleton == "x" { return index == parts.count }
    }
    return true
  }
  private static func alphabetic(_ value: String) -> Bool {
    !value.isEmpty && value.utf8.allSatisfy { (65...90).contains($0) || (97...122).contains($0) }
  }
  private static func alphanumeric(_ value: String) -> Bool {
    !value.isEmpty
      && value.utf8.allSatisfy {
        (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0)
      }
  }
  public static func displayNames(_ spans: [LanguageSpan], locale: Locale = .current) -> String {
    var seen: Set<String> = []
    return spans.compactMap { span in
      guard seen.insert(span.language).inserted else { return nil }
      return locale.localizedString(forIdentifier: span.language) ?? span.language
    }.joined(separator: " · ")
  }
}
