import Foundation

/// Stores only client input in the app sandbox, never server credentials.
/// Atomic replacement keeps the retry identity and payload in one checkpoint.
/// Actor isolation runs Foundation I/O off MainActor and serializes replacements.
public actor FileDraftStore: DraftStore {
  private let url: URL
  public init(url: URL) { self.url = url }
  public func load() throws -> SavedDraft {
    guard FileManager.default.fileExists(atPath: url.path) else {
      return SavedDraft.editable(text: "")
    }
    return try JSONDecoder().decode(SavedDraft.self, from: Data(contentsOf: url))
  }
  public func save(_ draft: SavedDraft) throws {
    try FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let data = try JSONEncoder().encode(draft)
    try data.write(to: url, options: .atomic)
  }
}
