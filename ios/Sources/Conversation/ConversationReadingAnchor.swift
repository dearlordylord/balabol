#if canImport(SwiftUI)
  import SwiftUI

  /// Matching row and viewport anchors restores the same visible pixel after a prepend.
  struct ConversationReadingAnchor {
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

#endif
