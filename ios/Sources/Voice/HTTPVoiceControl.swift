import Foundation

public actor HTTPVoiceControl: VoiceControl {
  private let baseURL: URL
  private let session: URLSession
  private var capabilities: [UUID: String] = [:]
  private var publishers: [UUID: UUID] = [:]
  private var incarnations: [UUID: UUID] = [:]
  private var deadlines: [UUID: Double] = [:]
  private var retainedSessions: Set<UUID> = []
  private var currentSession: UUID?
  public init(baseURL: URL, session: URLSession) throws {
    self.baseURL = try Self.normalizedOrigin(baseURL)
    self.session = session
  }
  public nonisolated static func normalizedOrigin(_ url: URL) throws -> URL {
    guard var parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
      let scheme = parts.scheme?.lowercased(), ["http", "https"].contains(scheme),
      let host = parts.host?.lowercased(), !host.isEmpty, parts.user == nil, parts.password == nil,
      ["", "/"].contains(parts.path), parts.query == nil, parts.fragment == nil
    else { throw VoiceFailure.invalidResponse }
    parts.scheme = scheme
    parts.host = host
    parts.path = ""
    if (scheme == "https" && parts.port == 443) || (scheme == "http" && parts.port == 80) {
      parts.port = nil
    }
    guard let origin = parts.url else { throw VoiceFailure.invalidResponse }
    return origin
  }
  public func languages() async throws -> VoiceLanguages {
    let value = try decode(VoiceLanguages.self, await request("voice/languages"))
    guard value.isValid else { throw VoiceFailure.invalidResponse }
    return value
  }

  public func start(requestId: UUID, muted: Bool) async throws -> VoiceJoin {
    struct Body: Encodable {
      let startRequestId: UUID
      let muted: Bool
    }
    let data = try await request(
      "voice/sessions", body: JSONEncoder().encode(Body(startRequestId: requestId, muted: muted)))
    let join = try decode(VoiceJoin.self, data)
    guard let media = URL(string: join.mediaUrl), ["ws", "wss"].contains(media.scheme),
      media.host != nil, media.user == nil, media.password == nil,
      media.query == nil, media.fragment == nil, !join.token.isEmpty, join.token.utf8.count <= 8192,
      UUID(uuidString: join.roomName) != nil, UUID(uuidString: join.participantIdentity) != nil,
      join.startRequestId == requestId,
      join.expiresAt.isFinite, join.joinDeadlineAt.isFinite, join.controlDeadlineAt.isFinite,
      join.joinDeadlineAt > 0, join.controlDeadlineAt >= join.joinDeadlineAt,
      join.controlToken.count == 64, join.controlToken.allSatisfy({ $0.isHexDigit })
    else { throw VoiceFailure.invalidResponse }
    let now = Date().timeIntervalSince1970 * 1000
    guard join.expiresAt > now, join.joinDeadlineAt > now, join.controlDeadlineAt > now else {
      throw VoiceFailure.backend(code: "StartExpired", message: "Voice bootstrap expired")
    }
    currentSession = join.sessionId
    pruneCapabilities()
    capabilities[join.sessionId] = join.controlToken
    publishers[join.sessionId] = join.backendParticipantIdentity
    incarnations[join.sessionId] = join.backendIncarnationId
    deadlines[join.sessionId] = join.controlDeadlineAt
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
    guard page.sessionId == sessionId, page.backendIncarnationId == incarnations[sessionId],
      page.controlDeadlineAt.isFinite, page.controlDeadlineAt > 0,
      ["active", "ended"].contains(page.status),
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
      page.pending.allSatisfy({ $0.backendIncarnationId == page.backendIncarnationId }),
      page.events.allSatisfy({
        $0.kind != "Final" || $0.backendIncarnationId == page.backendIncarnationId
      }),
      Set(page.pending.map(\.utteranceId)).count == page.pending.count,
      page.events.first?.sequence == max(after + 1, page.firstSequence) || page.sequence == after,
      page.events.last.map({ $0.sequence <= page.sequence }) ?? true,
      page.nextAfter == page.sequence,
      page.output.map({ validOutput($0, sessionId: sessionId) }) ?? true,
      page.events.allSatisfy({ $0.output.map({ validOutput($0, sessionId: sessionId) }) ?? true })
    else { throw VoiceFailure.invalidResponse }
    deadlines[sessionId] = page.controlDeadlineAt
    return page
  }
  public func mute(sessionId: UUID, muted: Bool) async throws {
    let data = try await request(
      "voice/sessions/\(sessionId.uuidString)/mute",
      body: JSONEncoder().encode(MuteBody(muted: muted)), sessionId: sessionId)
    _ = try validatedSnapshot(data, sessionId: sessionId, after: 0)
  }
  public func end(sessionId: UUID) async throws { _ = try await seal(sessionId: sessionId) }
  public func seal(sessionId: UUID) async throws -> VoiceSealResult {
    guard let incarnation = incarnations[sessionId] else { throw VoiceFailure.invalidResponse }
    do {
      let data = try await request(
        "voice/sessions/\(sessionId.uuidString)/end", body: Data("{}".utf8), sessionId: sessionId,
        producerIncarnation: incarnation)
      let page = try validatedSnapshot(data, sessionId: sessionId, after: 0)
      guard page.status == "ended" else { throw VoiceFailure.invalidResponse }
      pruneCapabilities()
      return .ended(page)
    } catch let closure as AbsentProducer {
      return .producerUnavailable(
        sessionId: closure.sessionId, backendIncarnationId: closure.incarnation)
    }
  }
  private struct AbsentProducer: Error {
    let sessionId: UUID
    let incarnation: UUID
  }
  public func retain(admissions: [VoiceAdmissionAssociation]) async {
    retainedSessions = Set(admissions.prefix(2).map(\.sessionId))
    pruneCapabilities()
  }
  private func pruneCapabilities() {
    // Lease deadlines express availability, not producer closure. Preserve
    // bounded current/draining Join authority until seal or replacement, even
    // when a late admission checkpoint arrives after its control deadline.
    for id in capabilities.keys
    where id != currentSession && !retainedSessions.contains(id) {
      capabilities.removeValue(forKey: id)
      publishers.removeValue(forKey: id)
      incarnations.removeValue(forKey: id)
      deadlines.removeValue(forKey: id)
    }
  }
  public func resolve(admissions: [VoiceAdmissionAssociation]) async throws
    -> VoiceAdmissionResolution
  {
    guard !admissions.isEmpty, admissions.count <= 2,
      Set(admissions.map(\.deliveryId)).count == admissions.count
    else { throw VoiceFailure.invalidResponse }
    struct Body: Encodable { let admissions: [VoiceAdmissionAssociation] }
    let data = try await request(
      "voice/admissions/resolve", body: JSONEncoder().encode(Body(admissions: admissions)))
    let value = try decode(VoiceAdmissionResolution.self, data)
    guard value.isValid(for: admissions) else { throw VoiceFailure.invalidResponse }
    return value
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
  internal static func isProducerClosure(statusCode: Int, data: Data) -> Bool {
    guard statusCode == 404,
      let failure = try? JSONDecoder().decode(FailureBody.self, from: data),
      failure.error.code == "SessionNotFound", failure.error.code.utf16.count <= 100,
      failure.error.message.utf16.count <= 1000
    else { return false }
    return true
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
  private func request(
    _ path: String, body: Data? = nil, after: Int? = nil, sessionId: UUID? = nil,
    producerIncarnation: UUID? = nil
  )
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
      #if DEBUG
        if !Task.isCancelled {
          VoiceTransitionTrace.shared.record(
            .transportFailed, status: "voice-http-network", failure: .connection,
            session: sessionId, networkCode: (error as? URLError)?.code.rawValue)
        }
      #endif
      throw VoiceFailure.connection
    }
    guard let http = response as? HTTPURLResponse, data.count <= 1_048_576 else {
      #if DEBUG
        VoiceTransitionTrace.shared.record(
          .transportFailed, status: "voice-http-envelope", failure: .invalidResponse,
          session: sessionId, httpStatus: (response as? HTTPURLResponse)?.statusCode)
      #endif
      throw VoiceFailure.invalidResponse
    }
    guard (200..<300).contains(http.statusCode) else {
      if let sessionId, let producerIncarnation,
        incarnations[sessionId] == producerIncarnation,
        Self.isProducerClosure(statusCode: http.statusCode, data: data)
      {
        throw AbsentProducer(sessionId: sessionId, incarnation: producerIncarnation)
      }
      if let failure = try? JSONDecoder().decode(FailureBody.self, from: data),
        !failure.error.code.isEmpty, !failure.error.message.isEmpty
      {
        #if DEBUG
          VoiceTransitionTrace.shared.record(
            .transportFailed, status: "voice-http-status",
            failure: .backend(code: failure.error.code, message: ""), session: sessionId,
            httpStatus: http.statusCode)
        #endif
        throw VoiceFailure.backend(code: failure.error.code, message: failure.error.message)
      }
      #if DEBUG
        VoiceTransitionTrace.shared.record(
          .transportFailed, status: "voice-http-status",
          failure: .connection, session: sessionId, httpStatus: http.statusCode)
      #endif
      throw VoiceFailure.connection
    }
    return data
  }
}
