import Foundation

public actor HTTPVoiceControl: VoiceControl {
  private let baseURL: URL
  private let session: URLSession
  private var capabilities: [UUID: String] = [:]
  private var publishers: [UUID: UUID] = [:]
  public init(baseURL: URL, session: URLSession) throws {
    guard ["http", "https"].contains(baseURL.scheme), baseURL.host != nil,
      baseURL.user == nil, baseURL.password == nil,
      ["", "/"].contains(baseURL.path), baseURL.query == nil, baseURL.fragment == nil
    else { throw VoiceFailure.invalidResponse }
    self.baseURL = baseURL
    self.session = session
  }
  public func start() async throws -> VoiceJoin {
    let data = try await request("voice/sessions", body: Data("{}".utf8))
    let join = try decode(VoiceJoin.self, data)
    guard let media = URL(string: join.mediaUrl), ["ws", "wss"].contains(media.scheme),
      media.host != nil, media.user == nil, media.password == nil,
      media.query == nil, media.fragment == nil, !join.token.isEmpty, join.token.utf8.count <= 8192,
      UUID(uuidString: join.roomName) != nil, UUID(uuidString: join.participantIdentity) != nil,
      join.expiresAt.isFinite, join.expiresAt > Date().timeIntervalSince1970 * 1000,
      join.controlToken.count == 64, join.controlToken.allSatisfy({ $0.isHexDigit })
    else { throw VoiceFailure.invalidResponse }
    capabilities = [join.sessionId: join.controlToken]
    publishers = [join.sessionId: join.backendParticipantIdentity]
    return join
  }
  public func snapshot(sessionId: UUID, after: Int) async throws -> VoiceSnapshot {
    let data = try await request(
      "voice/sessions/\(sessionId.uuidString)", after: after, sessionId: sessionId)
    return try validatedSnapshot(data, sessionId: sessionId, after: after)
  }
  private func validatedSnapshot(_ data: Data, sessionId: UUID, after: Int) throws -> VoiceSnapshot
  {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      object.keys.contains("output")
    else { throw VoiceFailure.invalidResponse }
    let page = try decode(VoiceSnapshot.self, data)
    guard page.sessionId == sessionId, ["active", "ended"].contains(page.status),
      after >= 0, after < Int.max, page.sequence >= after, page.sequence < Int.max,
      page.firstSequence > 0, page.firstSequence <= page.sequence + 1,
      page.audioFramesReceived >= 0, page.audioFramesReceived <= Int.max / 320,
      page.events.count <= 100,
      page.events.allSatisfy({ $0.sessionId == sessionId && $0.isValid }),
      zip(
        [max(after, page.firstSequence - 1)] + page.events.map(\.sequence),
        page.events.map(\.sequence)
      ).allSatisfy({
        $0 + 1 == $1
      }
      ),
      page.sampleFramesReceived >= 0,
      page.sampleFramesReceived == page.audioFramesReceived * 320,
      page.pending.count <= 2, page.pending.allSatisfy(\.isValid),
      Set(page.pending.map(\.utteranceId)).count == page.pending.count,
      page.events.first?.sequence == max(after + 1, page.firstSequence) || page.sequence == after,
      page.events.last.map({ $0.sequence <= page.sequence }) ?? true,
      page.nextAfter == page.sequence,
      page.output.map({ validOutput($0, sessionId: sessionId) }) ?? true,
      page.events.allSatisfy({ $0.output.map({ validOutput($0, sessionId: sessionId) }) ?? true })
    else { throw VoiceFailure.invalidResponse }
    return page
  }
  public func mute(sessionId: UUID, muted: Bool) async throws {
    let data = try await request(
      "voice/sessions/\(sessionId.uuidString)/mute",
      body: JSONEncoder().encode(MuteBody(muted: muted)), sessionId: sessionId)
    _ = try validatedSnapshot(data, sessionId: sessionId, after: 0)
  }
  public func end(sessionId: UUID) async throws {
    let data = try await request(
      "voice/sessions/\(sessionId.uuidString)/end", body: Data("{}".utf8), sessionId: sessionId)
    _ = try validatedSnapshot(data, sessionId: sessionId, after: 0)
  }
  private func validOutput(_ output: VoiceOutput, sessionId: UUID) -> Bool {
    output.isValid(sessionId: sessionId)
      && (output.manifest.map { $0.publisherIdentity == publishers[sessionId] } ?? true)
  }
  public func ready(sessionId: UUID, manifest: VoiceAudioManifest) async throws -> VoiceSnapshot {
    struct Body: Encodable {
      let responseId: UUID
      let outputEpoch: UUID
      let trackSid: String
    }
    let data = try await request(
      "voice/sessions/\(sessionId.uuidString)/output/ready",
      body: JSONEncoder().encode(
        Body(
          responseId: manifest.responseId, outputEpoch: manifest.outputEpoch,
          trackSid: manifest.trackSid)), sessionId: sessionId)
    return try validatedSnapshot(data, sessionId: sessionId, after: 0)
  }
  public func interrupt(sessionId: UUID, target: VoiceOutputIdentity) async throws -> VoiceSnapshot
  {
    let data = try await request(
      "voice/sessions/\(sessionId.uuidString)/output/interrupt",
      body: JSONEncoder().encode(target), sessionId: sessionId)
    return try validatedSnapshot(data, sessionId: sessionId, after: 0)
  }
  private struct FailureBody: Decodable {
    let error: VoicePending.Failure
  }
  private struct MuteBody: Encodable { let muted: Bool }
  private func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
    do { return try JSONDecoder().decode(type, from: data) } catch {
      throw VoiceFailure.invalidResponse
    }
  }
  private func request(_ path: String, body: Data? = nil, after: Int? = nil, sessionId: UUID? = nil)
    async throws -> Data
  {
    guard
      var components = URLComponents(
        url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)
    else { throw VoiceFailure.invalidResponse }
    if let after { components.queryItems = [URLQueryItem(name: "after", value: String(after))] }
    guard let url = components.url else { throw VoiceFailure.invalidResponse }
    var request = URLRequest(url: url)
    if let sessionId {
      guard let token = capabilities[sessionId] else { throw VoiceFailure.invalidResponse }
      request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
    }
    request.timeoutInterval = 15
    request.httpMethod = body == nil ? "GET" : "POST"
    request.httpBody = body
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    let data: Data
    let response: URLResponse
    do { (data, response) = try await session.data(for: request) } catch {
      throw VoiceFailure.connection
    }
    guard let http = response as? HTTPURLResponse, data.count <= 1_048_576 else {
      throw VoiceFailure.invalidResponse
    }
    guard (200..<300).contains(http.statusCode) else {
      if let failure = try? JSONDecoder().decode(FailureBody.self, from: data),
        !failure.error.code.isEmpty, !failure.error.message.isEmpty
      {
        throw VoiceFailure.backend(code: failure.error.code, message: failure.error.message)
      }
      throw VoiceFailure.connection
    }
    return data
  }
}
