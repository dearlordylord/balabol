import Foundation

public struct UsageTokens: Decodable, Equatable, Sendable {
  public let input: Int?
  public let cachedInput: Int?
  public let output: Int?
  public let reasoningOutput: Int?
  var isValid: Bool {
    [input, cachedInput, output, reasoningOutput].compactMap { $0 }.allSatisfy { $0 >= 0 }
      && Self.within(cachedInput, input)
      && Self.within(reasoningOutput, output)
  }
  private static func within(_ part: Int?, _ whole: Int?) -> Bool {
    guard let part, let whole else { return true }
    return part <= whole
  }
}
public struct UsageTotal: Decodable, Equatable, Sendable {
  public let category: String
  public let model: String
  public let attempts: Int
  public let unreported: Int
  public let input: Int?
  public let cachedInput: Int?
  public let output: Int?
  public let reasoningOutput: Int?
  var isValid: Bool {
    ["chat", "memory"].contains(category) && attempts >= 0 && unreported >= 0 && unreported <= attempts
      && [input, cachedInput, output, reasoningOutput].compactMap { $0 }.allSatisfy { $0 >= 0 }
  }
}
public struct UsageAttempt: Decodable, Equatable, Sendable, Identifiable {
  public let id: UUID
  public let category: String
  public let model: String
  public let startedAt: Double
  public let outcome: String
  public let tokens: UsageTokens
  var isValid: Bool {
    ["chat", "memory"].contains(category) && startedAt.isFinite && startedAt >= 0 && tokens.isValid
      && ["running", "completed", "interrupted", "failed"].contains(outcome)
  }
}
public struct UsageLedgerSnapshot: Decodable, Equatable, Sendable {
  public let since: Double?
  public let degraded: Bool
  public let totals: [UsageTotal]
  public let recent: [UsageAttempt]
}
public struct SpeechUsageTotal: Decodable, Equatable, Sendable {
  public let model: String
  public let costUSD: String
  public let requests: Int
  public let inputTextTokens: Int
  public let inputAudioTokens: Int
  public let outputTextTokens: Int
  public let outputAudioTokens: Int
  public let inputAudioMillis: Int
  public let outputAudioMillis: Int
  enum CodingKeys: String, CodingKey {
    case model
    case costUSD = "total_api_cost_usd", requests = "total_num_requests"
    case inputTextTokens = "total_input_text_tokens", inputAudioTokens = "total_input_audio_tokens"
    case outputTextTokens = "total_output_text_tokens", outputAudioTokens = "total_output_audio_tokens"
    case inputAudioMillis = "total_input_audio_duration_ms", outputAudioMillis = "total_output_audio_duration_ms"
  }
  var isValid: Bool {
    costUSD.range(of: #"^(0|[1-9][0-9]*)(\.[0-9]{1,12})?$"#, options: .regularExpression) != nil
      && [requests, inputTextTokens, inputAudioTokens, outputTextTokens, outputAudioTokens,
        inputAudioMillis, outputAudioMillis].allSatisfy { $0 >= 0 }
  }
}
public struct SpeechUsageSnapshot: Decodable, Equatable, Sendable {
  public let scope: String
  public let status: String
  public let startTime: String
  public let endTime: String
  public let fetchedAt: Double
  public let models: [SpeechUsageTotal]
}
public struct UsageSnapshot: Decodable, Equatable, Sendable {
  public let ledger: UsageLedgerSnapshot
  public let speech: SpeechUsageSnapshot
  public var isValid: Bool {
    ledger.totals.count <= 4 && ledger.recent.count <= 20 && ledger.totals.allSatisfy(\.isValid)
      && ledger.recent.allSatisfy(\.isValid) && speech.models.count <= 64
      && speech.models.allSatisfy(\.isValid) && speech.fetchedAt.isFinite && speech.fetchedAt >= 0
      && ["available", "notConfigured", "authentication", "permission", "unavailable"].contains(speech.status)
      && (ledger.since.map { $0.isFinite && $0 >= 0 } ?? true)
  }
}
public enum UsageFailure: Error, Equatable, Sendable {
  case connection, authentication, unavailable, invalidResponse
  public var message: String {
    switch self {
    case .connection: "Couldn’t connect. Pull to refresh."
    case .authentication: "Authentication is required to read usage."
    case .unavailable: "Usage is temporarily unavailable. Pull to refresh."
    case .invalidResponse: "The server returned invalid usage data."
    }
  }
}
@MainActor public protocol UsageClient {
  func load() async throws -> UsageSnapshot
}
