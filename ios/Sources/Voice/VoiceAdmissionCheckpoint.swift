import CryptoKit
import Foundation

/// Bounded local admission provenance. No transcript, media JWT or capability is persisted.
public protocol VoiceAdmissionCheckpoint: Sendable {
  func load() async throws -> [VoiceAdmissionAssociation]
  func save(_ admissions: [VoiceAdmissionAssociation]) async throws
}

public actor VolatileVoiceAdmissionCheckpoint: VoiceAdmissionCheckpoint {
  private var value: [VoiceAdmissionAssociation] = []
  public init() {}
  public func load() -> [VoiceAdmissionAssociation] { value }
  public func save(_ admissions: [VoiceAdmissionAssociation]) throws {
    guard admissions.count <= 2, Set(admissions.map(\.deliveryId)).count == admissions.count else {
      throw VoiceFailure.invalidResponse
    }
    value = admissions
  }
}

public actor FileVoiceAdmissionCheckpoint: VoiceAdmissionCheckpoint {
  private struct Envelope: Codable {
    let controlOrigin: String
    let admissions: [VoiceAdmissionAssociation]
  }
  private let url: URL
  private let origin: String
  public init(url: URL, controlOrigin: URL) throws {
    self.url = url
    origin = try HTTPVoiceControl.normalizedOrigin(controlOrigin).absoluteString
  }
  public nonisolated static func fileURL(in directory: URL, controlOrigin: URL) throws -> URL {
    let origin = try HTTPVoiceControl.normalizedOrigin(controlOrigin).absoluteString
    let digest = SHA256.hash(data: Data(origin.utf8)).map { String(format: "%02x", $0) }.joined()
    return directory.appendingPathComponent("voice-admissions-" + digest + ".json")
  }
  public func load() throws -> [VoiceAdmissionAssociation] {
    guard FileManager.default.fileExists(atPath: url.path) else { return [] }
    do {
      let file = try FileHandle(forReadingFrom: url)
      defer { try? file.close() }
      let data = try file.read(upToCount: 4097) ?? Data()
      guard data.count <= 4096 else { throw VoiceFailure.invalidResponse }
      let value = try JSONDecoder().decode(Envelope.self, from: data)
      if value.controlOrigin != origin, value.admissions.isEmpty { return [] }
      guard value.controlOrigin == origin, value.admissions.count <= 2,
        Set(value.admissions.map(\.deliveryId)).count == value.admissions.count
      else { throw VoiceFailure.invalidResponse }
      return value.admissions
    } catch { throw VoiceFailure.checkpointUnavailable }
  }
  public func save(_ admissions: [VoiceAdmissionAssociation]) throws {
    guard admissions.count <= 2, Set(admissions.map(\.deliveryId)).count == admissions.count else {
      throw VoiceFailure.invalidResponse
    }
    do {
      try FileManager.default.createDirectory(
        at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
      let data = try JSONEncoder().encode(Envelope(controlOrigin: origin, admissions: admissions))
      #if os(iOS)
        try data.write(
          to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      #else
        try data.write(to: url, options: .atomic)
      #endif
    } catch { throw VoiceFailure.checkpointUnavailable }
  }
}
