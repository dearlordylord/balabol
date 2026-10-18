import Foundation

@MainActor public final class HTTPUsageClient: UsageClient {
  private let url: URL
  private let session: URLSession
  public init(baseURL: URL, session: URLSession) {
    self.url = baseURL.appendingPathComponent("usage")
    self.session = session
  }
  public func load() async throws -> UsageSnapshot {
    var request = URLRequest(url: url)
    request.timeoutInterval = 15
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    let data: Data
    let response: URLResponse
    do { (data, response) = try await session.data(for: request) }
    catch is CancellationError { throw CancellationError() }
    catch { throw UsageFailure.connection }
    guard let http = response as? HTTPURLResponse else { throw UsageFailure.invalidResponse }
    if http.statusCode == 401 || http.statusCode == 403 { throw UsageFailure.authentication }
    guard http.statusCode == 200 else { throw UsageFailure.unavailable }
    guard data.count <= 1_048_576,
      let snapshot = try? JSONDecoder().decode(UsageSnapshot.self, from: data), snapshot.isValid
    else { throw UsageFailure.invalidResponse }
    return snapshot
  }
}
