import Foundation

/// Explicitly configured endpoint; no global runtime, credentials or implicit
/// network acquisition. URLSession is injected and owned by the composition root.
public struct HTTPConversationTransport: ConversationTransport {
  private let baseURL: URL
  private let session: URLSession
  public init(baseURL: URL, session: URLSession) throws {
    guard ["http", "https"].contains(baseURL.scheme), baseURL.host != nil,
      baseURL.user == nil, baseURL.password == nil,
      baseURL.query == nil, baseURL.fragment == nil,
      baseURL.path.isEmpty || baseURL.path == "/"
    else {
      throw ConversationFailure.invalidInput
    }
    self.baseURL = baseURL
    self.session = session
  }
  public func send(_ delivery: PendingDelivery) async throws -> ConversationMessage {
    guard !delivery.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw ConversationFailure.invalidInput
    }
    var request = URLRequest(url: baseURL.appendingPathComponent("conversation/messages"))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONEncoder().encode(delivery)
    return try await execute(request, as: ConversationMessage.self)
  }
  public func history(after: Int?) async throws -> HistoryPage {
    guard after.map({ $0 >= 0 }) ?? true else { throw ConversationFailure.invalidInput }
    guard
      var components = URLComponents(
        url: baseURL.appendingPathComponent("conversation/messages"), resolvingAgainstBaseURL: false
      )
    else { throw ConversationFailure.invalidInput }
    components.queryItems = [
      URLQueryItem(name: "limit", value: String(HistoryPage.maximumMessages))
    ]
    if let after {
      components.queryItems?.append(URLQueryItem(name: "after", value: String(after)))
    }
    guard let url = components.url else { throw ConversationFailure.invalidInput }
    return try await execute(URLRequest(url: url), as: HistoryPage.self)
  }
  private func execute<Value: Decodable>(_ request: URLRequest, as type: Value.Type) async throws
    -> Value
  {
    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse, data.count <= 8_388_608 else {
      throw ConversationFailure.invalidResponse
    }
    guard http.statusCode == 200 else {
      guard let envelope = try? JSONDecoder().decode(ErrorEnvelope.self, from: data) else {
        throw ConversationFailure.invalidResponse
      }
      guard !envelope.error.code.isEmpty,
        envelope.error.code != "InvalidInput" || http.statusCode == 400,
        envelope.error.code != "DeliveryConflict" || http.statusCode == 409
      else {
        throw ConversationFailure.invalidResponse
      }
      throw ConversationFailure.rejected(code: envelope.error.code, message: envelope.error.message)
    }
    do { return try JSONDecoder().decode(type, from: data) } catch {
      throw ConversationFailure.invalidResponse
    }
  }
  private struct ErrorEnvelope: Decodable {
    let error: ServerFailure
  }
  private struct ServerFailure: Decodable {
    let code: String
    let message: String
  }
}
