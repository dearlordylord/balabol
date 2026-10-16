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
  public func interruptReply(responseId: UUID, inputDeliveryId: UUID) async throws -> ReplySnapshot?
  {
    struct Target: Encodable {
      let responseId: UUID
      let inputDeliveryId: UUID
    }
    var request = URLRequest(url: baseURL.appendingPathComponent("conversation/replies/interrupt"))
    request.httpMethod = "POST"
    request.timeoutInterval = 15
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONEncoder().encode(
      Target(responseId: responseId, inputDeliveryId: inputDeliveryId))
    let result = try await execute(request, as: ReplySnapshot?.self)
    guard
      result.map({
        $0.isValid && $0.responseId == responseId && $0.inputDeliveryId == inputDeliveryId
      }) ?? true
    else {
      throw ConversationFailure.invalidResponse
    }
    return result
  }
  public func currentTurn() async throws -> CurrentTurn? {
    var request = URLRequest(url: baseURL.appendingPathComponent("conversation/current"))
    request.timeoutInterval = 15
    return try await execute(request, as: CurrentTurn?.self)
  }
  public func retryReply(for inputDeliveryId: UUID) async throws -> ReplySnapshot {
    var request = URLRequest(
      url: baseURL.appendingPathComponent(
        "conversation/replies/" + inputDeliveryId.uuidString + "/retry"))
    request.httpMethod = "POST"
    request.timeoutInterval = 15
    return try await execute(request, as: ReplySnapshot.self)
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
  public func replySnapshot(for inputDeliveryId: UUID) async throws -> ReplySnapshot {
    let url = baseURL.appendingPathComponent("conversation/replies/" + inputDeliveryId.uuidString)
    var request = URLRequest(url: url)
    request.timeoutInterval = 15
    return try await execute(request, as: ReplySnapshot.self)
  }
  public func observeReply(for inputDeliveryId: UUID) async throws -> ReplyObservation {
    let url = baseURL.appendingPathComponent(
      "conversation/replies/" + inputDeliveryId.uuidString + "/events")
    var request = URLRequest(url: url)
    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
    // Reply observation has its own idle lifetime, not the short POST timeout.
    request.timeoutInterval = 300
    let stream = AsyncThrowingStream<ReplySnapshot, any Error>.makeStream(
      bufferingPolicy: .bufferingOldest(16))
    let session = session
    let reader = Task {
      do {
        let (bytes, response) = try await session.bytes(for: request)
        defer { bytes.task.cancel() }
        guard let http = response as? HTTPURLResponse else {
          throw ConversationFailure.invalidResponse
        }
        if http.statusCode != 200 {
          var data = Data()
          for try await byte in bytes {
            guard data.count < 2_097_152 else { throw ConversationFailure.invalidResponse }
            data.append(byte)
          }
          let error = try JSONDecoder().decode(ErrorEnvelope.self, from: data)
          throw ConversationFailure.rejected(code: error.error.code, message: error.error.message)
        }
        guard
          http.value(forHTTPHeaderField: "Content-Type")?.lowercased().hasPrefix(
            "text/event-stream") == true
        else { throw ConversationFailure.invalidResponse }
        var line = Data()
        var frame = Data()
        var hasData = false
        for try await byte in bytes {
          try Task.checkCancellation()
          if byte != 10 {
            guard line.count < 2_097_152 else { throw ConversationFailure.invalidResponse }
            line.append(byte)
            continue
          }
          if line.last == 13 { line.removeLast() }
          if line.isEmpty {
            if hasData {
              let snapshot: ReplySnapshot
              do { snapshot = try JSONDecoder().decode(ReplySnapshot.self, from: frame) } catch {
                throw ConversationFailure.invalidResponse
              }
              switch stream.continuation.yield(snapshot) {
              case .enqueued: break
              case .terminated: return
              case .dropped: throw ConversationFailure.invalidResponse
              @unknown default: throw ConversationFailure.invalidResponse
              }
              if snapshot.isTerminal {
                stream.continuation.finish()
                return
              }
            }
            frame.removeAll(keepingCapacity: true)
            hasData = false
          } else if line.starts(with: Array("data:".utf8)) {
            var payload = line.dropFirst(5)
            if payload.first == 32 { payload = payload.dropFirst() }
            if hasData { frame.append(10) }
            guard frame.count + payload.count <= 2_097_152 else {
              throw ConversationFailure.invalidResponse
            }
            frame.append(contentsOf: payload)
            hasData = true
          }
          line.removeAll(keepingCapacity: true)
        }
        throw ConversationFailure.unavailable
      } catch let error as ConversationFailure { stream.continuation.finish(throwing: error) } catch
      { stream.continuation.finish(throwing: ConversationFailure.unavailable) }
    }
    stream.continuation.onTermination = { _ in reader.cancel() }
    return ReplyObservation(
      events: stream.stream,
      cancel: {
        reader.cancel()
        stream.continuation.finish()
      })
  }
  public func olderHistory(before: Int?) async throws -> OlderHistoryPage {
    guard before.map({ $0 >= 0 }) ?? true else { throw ConversationFailure.invalidInput }
    guard
      var components = URLComponents(
        url: baseURL.appendingPathComponent("conversation/messages"), resolvingAgainstBaseURL: false
      )
    else { throw ConversationFailure.invalidInput }
    components.queryItems = [
      URLQueryItem(name: "direction", value: "older"),
      URLQueryItem(name: "limit", value: String(OlderHistoryPage.maximumMessages)),
    ]
    if let before {
      components.queryItems?.append(URLQueryItem(name: "before", value: String(before)))
    }
    guard let url = components.url else { throw ConversationFailure.invalidInput }
    return try await execute(URLRequest(url: url), as: OlderHistoryPage.self)
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
