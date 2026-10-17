import Foundation

/// Native notification delivery can outlive the physical capture it observed.
/// This adapter fence rejects notifications already queued by that old lifetime.
internal struct VoicePlatformEpoch: Sendable {
  private(set) var identity = UUID()
  mutating func advance(to identity: UUID) { self.identity = identity }
  func accepts(_ identity: UUID) -> Bool { self.identity == identity }
}
