#if os(iOS)
  import AVFoundation
  import LiveKit
  import Foundation
  import os

  /// LiveKit AudioManager.shared automatic AVAudioSession configuration is the
  /// sole audio owner. No AVAudioEngine or manual audio-session activation here.
  @MainActor public final class LiveKitVoiceMedia: VoiceMedia {
    private var room: Room?
    private var delegate: VoiceRoomDelegate?
    private var generation = 0
    private let evidenceEnabled: Bool
    private var evidenceTask: Task<Void, Never>?
    public init(evidenceEnabled: Bool = false) {
      #if DEBUG
        self.evidenceEnabled = evidenceEnabled
      #else
        self.evidenceEnabled = false
      #endif
      LiveKitSDK.disableLogging()
    }
    public func requestPermission() async -> Bool {
      switch AVCaptureDevice.authorizationStatus(for: .audio) {
      case .authorized: return true
      case .notDetermined: return await AVCaptureDevice.requestAccess(for: .audio)
      default: return false
      }
    }
    public func connect(_ join: VoiceJoin, failure: @escaping @Sendable () -> Void) async throws {
      generation += 1
      let expected = generation
      let callback = VoiceRoomDelegate { [weak self] in
        Task { @MainActor in
          guard self?.generation == expected else { return }
          failure()
        }
      }
      let candidate = Room(delegate: callback)
      room = candidate
      delegate = callback
      do {
        try await candidate.connect(url: join.mediaUrl, token: join.token)
        guard expected == generation, !Task.isCancelled else {
          await candidate.disconnect()
          throw CancellationError()
        }
        do {
          guard let publication = try await candidate.localParticipant.setMicrophone(enabled: true),
            publication.track != nil, !publication.isMuted
          else { throw VoiceFailure.capture }
          if evidenceEnabled, let track = publication.track {
            startEvidence(track, generation: expected)
          }
        } catch {
          throw VoiceFailure.capture
        }
        guard expected == generation, !Task.isCancelled else {
          await candidate.disconnect()
          throw CancellationError()
        }
      } catch {
        await candidate.disconnect()
        if expected == generation {
          evidenceTask?.cancel()
          evidenceTask = nil
          room = nil
          delegate = nil
        }
        throw error
      }
    }
    public func mute(_ muted: Bool) async throws {
      guard let room else { throw VoiceFailure.capture }
      do {
        guard let publication = try await room.localParticipant.setMicrophone(enabled: !muted),
          publication.track != nil, publication.isMuted == muted
        else { throw VoiceFailure.capture }
      } catch {
        throw VoiceFailure.capture
      }
    }
    public func disconnect() async {
      generation += 1
      let task = evidenceTask
      evidenceTask?.cancel()
      evidenceTask = nil
      let candidate = room
      room = nil
      delegate = nil
      if let candidate {
        _ = try? await candidate.localParticipant.setMicrophone(enabled: false)
        await candidate.disconnect()
      }
      await task?.value
    }
    private func startEvidence(_ track: Track, generation expected: Int) {
      #if DEBUG
        guard evidenceEnabled else { return }
        evidenceTask?.cancel()
        evidenceTask = Task { [weak self] in
          await track.set(reportStatistics: true)
          for _ in 0..<30 {
            guard !Task.isCancelled, self?.generation == expected else { break }
            if !track.isMuted { VoiceRouteEvidence.record(track.statistics) }
            do { try await Task.sleep(for: .seconds(1)) } catch { break }
          }
          await track.set(reportStatistics: false)
        }
      #endif
    }

  }

  /// SDK delegates are Sendable and nonisolated; only immutable callbacks cross
  /// the SDK queue. The media owner checks room generation on the MainActor hop.
  private final class VoiceRoomDelegate: RoomDelegate {
    let failure: @Sendable () -> Void
    init(failure: @escaping @Sendable () -> Void) { self.failure = failure }
    func room(_ room: Room, didDisconnectWithError error: LiveKitError?) {
      failure()
    }
    func room(_ room: Room, didFailToConnectWithError error: LiveKitError?) { failure() }
    func roomIsReconnecting(_ room: Room) { failure() }
    func room(
      _ room: Room, participant: RemoteParticipant?, didReceiveData data: Data,
      forTopic topic: String, encryptionType: EncryptionType
    ) {
      // Transcript authority is the bounded control observation, not data packets.
    }
  }
#endif

#if os(iOS) && DEBUG
  private enum VoiceRouteEvidence {
    private static let logger = os.Logger(
      subsystem: "app.balabol.voice.evidence", category: "ice")
    static func record(_ stats: TrackStatistics?) {
      guard let stats else {
        logger.notice("statistics unavailable")
        return
      }
      if let outbound = stats.outboundRtpStream.first, let packets = outbound.packetsSent,
        let bytes = outbound.bytesSent
      {
        logger.notice(
          "microphone RTP packets=\(packets, privacy: .public) bytes=\(bytes, privacy: .public)")
      } else {
        logger.notice("microphone RTP statistics unavailable")
      }
      guard let selected = stats.transportStats?.selectedCandidatePairId,
        let pair = stats.iceCandidatePair.first(where: { $0.id == selected }),
        let local = stats.localIceCandidate, let remote = stats.remoteIceCandidate,
        local.id == pair.localCandidateId, remote.id == pair.remoteCandidateId,
        let localAddress = address(local.address), let remoteAddress = address(remote.address),
        let localPort = local.port, let remotePort = remote.port,
        (1...65535).contains(localPort), (1...65535).contains(remotePort),
        let protocolName = remote.protocol, ["udp", "tcp"].contains(protocolName)
      else {
        logger.notice("selected ICE candidates unavailable from public SDK statistics")
        return
      }
      logger.notice(
        "selected ICE local=\(localAddress, privacy: .public):\(localPort, privacy: .public) remote=\(remoteAddress, privacy: .public):\(remotePort, privacy: .public) protocol=\(protocolName, privacy: .public)"
      )
    }
    private static func address(_ value: String?) -> String? {
      guard let value, !value.isEmpty, value.count <= 45,
        value.unicodeScalars.allSatisfy({ "0123456789abcdefABCDEF.:".unicodeScalars.contains($0) })
      else { return nil }
      return value
    }
  }
#endif
