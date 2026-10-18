#if canImport(SwiftUI)
  import SwiftUI
  import os

  /// Matching row and viewport anchors restores the same visible pixel after a prepend.
  struct ConversationReadingAnchor: Equatable {
    let message: String
    private let originalY: CGFloat
    private let viewportHeight: CGFloat
    var alignment: UnitPoint
    var isRestoring = false
    private var correctionsRemaining = 8

    init?(frames: [String: CGRect], viewport: CGRect) {
      guard viewport.height > 0,
        let row = frames.filter({
          $0.value.intersects(viewport)
            && abs(viewport.height - $0.value.height) > 1
        }).min(by: { $0.value.minY < $1.value.minY })
      else { return nil }
      self.message = row.key
      self.originalY = row.value.minY
      self.viewportHeight = viewport.height
      self.alignment = UnitPoint(
        x: 0,
        y: (row.value.minY - viewport.minY) / (viewport.height - row.value.height))
    }
    // Lazy row estimates and content insets can settle after the initial scroll.
    mutating func refine(using frame: CGRect) -> Bool {
      let difference = originalY - frame.minY
      let distance = viewportHeight - frame.height
      guard abs(difference) > 1, abs(distance) > 1, correctionsRemaining > 0 else { return false }
      correctionsRemaining -= 1
      alignment.y += difference / distance
      return true
    }

  }

  struct ConversationRowFrames: PreferenceKey {
    static let defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
      value.merge(nextValue(), uniquingKeysWith: { _, new in new })
    }
  }

  /// Local layout evidence; positions and geometry only, never message text or IDs.
  actor ConversationViewportDiagnostics {
    struct Snapshot: Codable, Sendable {
      let uptime: Double
      let messages: Int
      let replyLength: Int
      let viewportHeight: Double
      let viewportWidth: Double
      let measuredRows: Int
      let visibleRows: Int
      let bottomOffset: Double?
    }
    private static let shared = ConversationViewportDiagnostics()
    private struct Pending: Sendable {
      var latest: Snapshot?
      var scheduled = false
    }
    private static let pending = OSAllocatedUnfairLock(initialState: Pending())
    nonisolated static func record(_ snapshot: Snapshot) {
      let schedule = pending.withLock { value in
        value.latest = snapshot
        guard !value.scheduled else { return false }
        value.scheduled = true
        return true
      }
      if schedule { Task { await shared.drain() } }
    }
    private func drain() async {
      while let snapshot = Self.pending.withLock({ value -> Snapshot? in
        let latest = value.latest
        value.latest = nil
        if latest == nil { value.scheduled = false }
        return latest
      }) {
        append(snapshot)
        try? await Task.sleep(for: .milliseconds(250))
      }
    }
    private var events: [Snapshot] = []
    private func append(_ snapshot: Snapshot) {
      events.append(snapshot)
      if events.count > 128 { events.removeFirst(events.count - 128) }
      do {
        let directory = try FileManager.default.url(
          for: .cachesDirectory,
          in: .userDomainMask, appropriateFor: nil, create: true)
        let data = try JSONEncoder().encode(events)
        #if os(iOS)
          try data.write(
            to: directory.appendingPathComponent("balabol-conversation-viewport.json"),
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
          try data.write(
            to: directory.appendingPathComponent("balabol-conversation-viewport.json"),
            options: .atomic)
        #endif
      } catch {
        NSLog("Balabol conversation viewport diagnostics could not be persisted")
      }
    }
  }
#endif
