#if DEBUG
  internal struct VoiceAudioDiagnosticBudget {
    private var stages: [String: Int] = [:]
    private var windows = 0
    mutating func admit(_ stage: String, periodic: Bool = false) -> Bool {
      if periodic {
        guard windows < 30 else { return false }
        windows += 1
      } else {
        guard stages[stage, default: 0] < 12 else { return false }
        stages[stage, default: 0] += 1
      }
      return true
    }
  }
#endif
