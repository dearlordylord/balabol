#if os(iOS)
  @preconcurrency import AVFoundation
  import LiveKit
  import Foundation
  import os

  /// LiveKit AudioManager.shared automatic AVAudioSession configuration is the
  /// sole audio owner. No AVAudioEngine or manual audio-session activation here.
  @MainActor public final class LiveKitVoiceMedia: VoiceMedia {
    private var platformObservers: [NSObjectProtocol] = []
    private var observationEpoch = UUID()
    private let platformCaptureEpoch = OSAllocatedUnfairLock(initialState: VoicePlatformEpoch())
    private var room: Room?
    private var delegate: VoiceRoomDelegate?
    private var generation = 0
    private var publisher: UUID?
    private var wanted: VoiceAudioManifest?
    private var outputTrack: RemoteAudioTrack?
    private var playbackRenderer: VoicePlaybackRenderer?
    private var outputReceived: (@Sendable (VoiceOutputIdentity) -> Void)?
    private var outputPublication: RemoteTrackPublication?
    private var microphone: LocalAudioTrack?
    private var renderer: VoiceSpeechRenderer?
    private var captureStopTask: Task<Void, Never>?
    private var speechTask: Task<Void, Never>?
    private var speechStartedCallback: (@MainActor @Sendable () -> Void)?
    #if DEBUG
      private var captureEvidenceTask: Task<Void, Never>?
    #endif
    private var suppressionTask: Task<Void, Never>?
    private var rejectedTrackTask: Task<Void, Never>?
    #if DEBUG
      private var remainingStopEvidence = 8
    #endif
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
    public func observePlatform(
      _ receive: @escaping @MainActor @Sendable (VoicePlatformEvent) -> Void
    ) {
      guard platformObservers.isEmpty else { return }
      let epoch = observationEpoch
      let captureEpoch = platformCaptureEpoch
      let deliver: @Sendable (VoicePlatformEvent) -> Void = { [weak self] event in
        let captured = captureEpoch.withLock { $0.identity }
        Task { @MainActor in
          guard let self, self.observationEpoch == epoch,
            captureEpoch.withLock({ $0.accepts(captured) })
          else { return }
          receive(event)
        }
      }
      let center = NotificationCenter.default
      func add(
        _ name: Notification.Name, decode: @escaping @Sendable (Notification) -> VoicePlatformEvent?
      ) {
        platformObservers.append(
          center.addObserver(forName: name, object: AVAudioSession.sharedInstance(), queue: nil) {
            notice in
            if let event = decode(notice) { deliver(event) }
          })
      }
      if #available(iOS 27.0, *) {
        add(AVAudioSession.didBecomeInactiveNotification) { notice in
          guard
            let context = notice.userInfo?[AVAudioSession.deactivationContextKey]
              as? AVAudioSession.DeactivationContext,
            context.source == .system
          else { return nil }
          // SDK-requested deactivation during mute/cleanup is not a call.
          return .interrupted
        }
        add(AVAudioSession.resumptionRecommendationNotification) { notice in
          guard
            let context = notice.userInfo?[AVAudioSession.resumptionContextKey]
              as? AVAudioSession.ResumptionContext
          else { return nil }
          return .resumeRecommended(context.recommendation == .shouldResume)
        }
      } else {
        add(AVAudioSession.interruptionNotification) { notice in
          guard
            let raw = (notice.userInfo?[AVAudioSessionInterruptionTypeKey] as? NSNumber)?.uintValue,
            let type = AVAudioSession.InterruptionType(rawValue: raw)
          else { return nil }
          if type == .began { return .interrupted }
          let options =
            (notice.userInfo?[AVAudioSessionInterruptionOptionKey] as? NSNumber)?.uintValue ?? 0
          return .resumeRecommended(
            AVAudioSession.InterruptionOptions(rawValue: options).contains(.shouldResume))
        }
      }
      add(AVAudioSession.routeChangeNotification) { notice in
        guard
          let previous = notice.userInfo?[AVAudioSessionRouteChangePreviousRouteKey]
            as? AVAudioSessionRouteDescription
        else { return nil }
        let privateTypes: Set<AVAudioSession.Port> = [
          .headphones, .bluetoothA2DP, .bluetoothHFP, .bluetoothLE,
        ]
        let wasPrivate = previous.outputs.contains { privateTypes.contains($0.portType) }
        let current = AVAudioSession.sharedInstance().currentRoute.outputs
        let nowPrivate = current.contains { privateTypes.contains($0.portType) }
        return .routeChanged(
          privateOutputRemoved: wasPrivate && !nowPrivate
            && current.contains { $0.portType == .builtInSpeaker })
      }
      add(AVAudioSession.mediaServicesWereLostNotification) { _ in .servicesLost }
      add(AVAudioSession.mediaServicesWereResetNotification) { _ in .servicesReset }
    }
    public func retirePlatformObservation() {
      observationEpoch = UUID()
      for token in platformObservers { NotificationCenter.default.removeObserver(token) }
      platformObservers = []
    }
    public func fenceCapture() -> Task<Void, Never> {
      let epoch = UUID()
      platformCaptureEpoch.withLock { $0.advance(to: epoch) }
      generation += 1
      renderer?.resetOnset()
      speechTask?.cancel()
      if let captureStopTask { return captureStopTask }
      let candidate = room
      let task = Task {
        if let candidate { _ = try? await candidate.localParticipant.setMicrophone(enabled: false) }
      }
      captureStopTask = task
      return task
    }
    public func requestPermission() async -> Bool {
      switch AVCaptureDevice.authorizationStatus(for: .audio) {
      case .authorized: return true
      case .notDetermined: return await AVCaptureDevice.requestAccess(for: .audio)
      default: return false
      }
    }
    public func connect(
      _ join: VoiceJoin, initiallyMuted: Bool, failure: @escaping @Sendable () -> Void,
      speechStarted: @escaping @MainActor @Sendable () -> Void,
      outputReceived: @escaping @Sendable (VoiceOutputIdentity) -> Void
    ) async throws {
      let epoch = UUID()
      platformCaptureEpoch.withLock { $0.advance(to: epoch) }
      generation += 1
      let expected = generation
      await captureStopTask?.value
      captureStopTask = nil
      guard expected == generation, !Task.isCancelled else { throw CancellationError() }
      publisher = join.backendParticipantIdentity
      self.outputReceived = outputReceived
      speechStartedCallback = speechStarted
      let callback = VoiceRoomDelegate(
        failure: { [weak self] in
          Task { @MainActor in
            guard self?.generation == expected else { return }
            failure()
          }
        },
        publication: { [weak self] participant, publication in
          Task { @MainActor in
            guard self?.generation == expected else { return }
            self?.received(participant, publication: publication)
          }
        })
      let candidate = Room(delegate: callback, connectOptions: ConnectOptions(autoSubscribe: false))
      room = candidate
      delegate = callback
      do {
        try await candidate.connect(url: join.mediaUrl, token: join.token)
        guard expected == generation, !Task.isCancelled else {
          await candidate.disconnect()
          throw CancellationError()
        }
        do {
          if !initiallyMuted {
            guard
              let publication = try await candidate.localParticipant.setMicrophone(enabled: true),
              let track = publication.track as? LocalAudioTrack, !publication.isMuted
            else { throw VoiceFailure.capture }
            installMicrophone(track, generation: expected, speechStarted: speechStarted)
            // Publication alone is signaling, not usable capture. A fresh
            // readable SDK renderer frame qualifies this attempt, even silence.
            try await awaitCapture(generation: expected)
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
    private func awaitCapture(generation expected: Int) async throws {
      for _ in 0..<100 {
        guard expected == generation, !Task.isCancelled else { throw CancellationError() }
        if renderer?.hasReadableCapture == true { return }
        try await Task.sleep(for: .milliseconds(50))
      }
      throw VoiceFailure.capture
    }
    private func installMicrophone(
      _ track: LocalAudioTrack, generation expected: Int,
      speechStarted: @escaping @MainActor @Sendable () -> Void
    ) {
      guard microphone !== track else { return }
      speechTask?.cancel()
      if let microphone, let renderer { microphone.remove(audioRenderer: renderer) }
      microphone = track
      let stream = AsyncStream<VoiceOnsetNotice>.makeStream(bufferingPolicy: .bufferingNewest(1))
      let renderer: VoiceSpeechRenderer
      #if DEBUG
        if evidenceEnabled {
          let evidence = AsyncStream<VoiceCaptureEvidence>.makeStream(
            bufferingPolicy: .bufferingNewest(1))
          captureEvidenceTask?.cancel()
          captureEvidenceTask = Task { [weak self] in
            let logger = os.Logger(
              subsystem: "app.balabol.voice.evidence", category: "capture")
            logger.notice("capture renderer attached")
            for await value in evidence.stream {
              guard !Task.isCancelled, self?.generation == expected else { return }
              logger.notice(
                "capture callbacks=\(value.callbacks, privacy: .public) frames=\(value.frames, privacy: .public) sampleRate=\(value.sampleRate, privacy: .public) format=\(value.format, privacy: .public) channels=\(value.channels, privacy: .public) interleaved=\(value.interleaved, privacy: .public) readable=\(value.readable, privacy: .public) peak=\(value.peak, privacy: .public) voiced=\(value.voiced, privacy: .public) onset=\(value.onset, privacy: .public)"
              )
            }
          }
          renderer = VoiceSpeechRenderer(
            started: { stream.continuation.yield($0) },
            diagnostic: { evidence.continuation.yield($0) })
        } else {
          renderer = VoiceSpeechRenderer { stream.continuation.yield($0) }
        }
      #else
        renderer = VoiceSpeechRenderer { stream.continuation.yield($0) }
      #endif
      self.renderer = renderer
      track.add(audioRenderer: renderer)
      speechTask = Task { [weak self] in
        for await notice in stream.stream {
          guard !Task.isCancelled, self?.generation == expected else { return }
          guard renderer.acceptsOnset(notice) else { continue }
          // The callback is MainActor-isolated: no second queue can deliver an
          // old notice after mute/unmute advances the capture epoch.
          speechStarted()
        }
      }

      if evidenceEnabled { startEvidence(track, generation: expected) }
    }
    public func mute(_ muted: Bool) async throws {
      let epoch = UUID()
      platformCaptureEpoch.withLock { $0.advance(to: epoch) }
      guard let room else { throw VoiceFailure.capture }
      let expected = generation
      if muted, microphone == nil { return }
      renderer?.resetOnset()
      do {
        guard let publication = try await room.localParticipant.setMicrophone(enabled: !muted),
          let track = publication.track as? LocalAudioTrack, publication.isMuted == muted,
          expected == generation, !Task.isCancelled
        else { throw VoiceFailure.capture }
        renderer?.resetOnset()
        if !muted, let speechStartedCallback {
          installMicrophone(track, generation: expected, speechStarted: speechStartedCallback)
          try await awaitCapture(generation: expected)
        }
      } catch { throw VoiceFailure.capture }
    }
    public func disconnect() async {
      await captureStopTask?.value
      let stopped = stopOutput()
      speechTask?.cancel()
      speechTask = nil
      #if DEBUG
        let captureEvidence = captureEvidenceTask
        captureEvidenceTask?.cancel()
        captureEvidenceTask = nil
      #endif
      if let microphone, let renderer { microphone.remove(audioRenderer: renderer) }
      microphone = nil
      renderer = nil
      speechStartedCallback = nil
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
      await stopped.value
      #if DEBUG
        await captureEvidence?.value
      #endif
      await rejectedTrackTask?.value
      rejectedTrackTask = nil
    }
    public func prepareOutput(_ manifest: VoiceAudioManifest) async throws {
      guard !Task.isCancelled, manifest.isValid, manifest.publisherIdentity == publisher,
        room != nil
      else { throw VoiceFailure.invalidResponse }
      let expected = generation
      wanted = manifest
      for _ in 0..<200 {
        guard !Task.isCancelled, expected == generation, wanted == manifest,
          let room
        else { throw CancellationError() }
        if let participant = room.remoteParticipants.values.first(where: {
          $0.identity.flatMap { UUID(uuidString: $0.stringValue) } == manifest.publisherIdentity
        }),
          let publication = participant.trackPublications.values.first(where: {
            $0.sid.stringValue == manifest.trackSid && $0.kind == .audio
          }) as? RemoteTrackPublication
        {
          if outputPublication !== publication {
            outputPublication = publication
            try await publication.set(subscribed: true)
          }
          if let track = publication.track as? RemoteAudioTrack, track.trackState == .started {
            guard wanted == manifest,
              expected == generation, !Task.isCancelled
            else {
              try? await track.stop()
              try? await publication.set(subscribed: false)
              throw CancellationError()
            }
            if outputTrack !== track {
              let callback = outputReceived
              let renderer = VoicePlaybackRenderer(evidenceEnabled: evidenceEnabled) {
                callback?(manifest.identity)
              }
              playbackRenderer = renderer
              track.add(audioRenderer: renderer)
            }
            outputTrack = track
            return
          }
        }
        try await Task.sleep(for: .milliseconds(50))
      }
      throw VoiceFailure.connection
    }
    public func stopOutput() -> Task<Void, Never> {
      #if DEBUG
        let manifest = wanted
      #endif
      wanted = nil
      let track = outputTrack
      let publication = outputPublication
      #if DEBUG
        let recordStop = evidenceEnabled && track != nil && remainingStopEvidence > 0
        if recordStop { remainingStopEvidence -= 1 }
      #endif
      if let track, let playbackRenderer { track.remove(audioRenderer: playbackRenderer) }
      playbackRenderer = nil
      outputTrack = nil
      outputPublication = nil
      if track == nil, publication == nil, let suppressionTask { return suppressionTask }
      let task = Task {
        // Stop on the SDK RTC executor before control interruption is sent.
        if let track {
          do {
            try await track.stop()
            #if DEBUG
              if recordStop, let manifest, track.trackState == .stopped {
                let logger = os.Logger(
                  subsystem: "app.balabol.voice.evidence", category: "playback")
                logger.notice(
                  "local SDK stop response=\(manifest.responseId.uuidString, privacy: .public) epoch=\(manifest.outputEpoch.uuidString, privacy: .public) sid=\(manifest.trackSid, privacy: .public) trackState=stopped"
                )
              }
            #endif
          } catch {
            // Session disconnect remains the cleanup owner if the SDK stop fails.
          }
        }
        if let publication { try? await publication.set(subscribed: false) }
      }
      suppressionTask = task
      return task
    }
    private func received(_ participant: RemoteParticipant, publication: RemoteTrackPublication) {
      let sid = publication.sid.stringValue
      let trusted = participant.identity.flatMap { UUID(uuidString: $0.stringValue) } == publisher
      guard trusted, publication.kind == .audio, wanted?.trackSid == sid else {
        if let track = publication.track as? RemoteAudioTrack {
          let previous = rejectedTrackTask
          previous?.cancel()
          rejectedTrackTask = Task {
            await previous?.value
            guard !Task.isCancelled else { return }
            try? await track.stop()
            try? await publication.set(subscribed: false)
          }
        }
        return
      }
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

  private final class VoicePlaybackRenderer: AudioRenderer {
    private let reported = OSAllocatedUnfairLock(initialState: false)
    private let received: @Sendable () -> Void
    private let evidenceEnabled: Bool
    init(evidenceEnabled: Bool, received: @escaping @Sendable () -> Void) {
      self.evidenceEnabled = evidenceEnabled
      self.received = received
    }
    func render(pcmBuffer: AVAudioPCMBuffer) {
      let count = min(Int(pcmBuffer.frameLength), 2048)
      guard count > 0 else { return }
      var nonzero = false
      if let data = pcmBuffer.floatChannelData?[0] {
        nonzero = (0..<count).contains { abs(data[$0]) > 0.0001 }
      } else if let data = pcmBuffer.int16ChannelData?[0] {
        nonzero = (0..<count).contains { data[$0] != 0 }
      }
      guard nonzero else { return }
      let first = reported.withLock { value in
        if value { return false }
        value = true
        return true
      }
      guard first else { return }
      received()
      #if DEBUG
        if evidenceEnabled {
          let logger = os.Logger(subsystem: "app.balabol.voice.evidence", category: "playback")
          logger.notice("remote fixture audio received nonzero samples=\(count, privacy: .public)")
        }
      #endif
    }
  }

  #if DEBUG
    private struct VoiceCaptureEvidence: Sendable {
      let callbacks: Int
      let frames: Int
      let sampleRate: Double
      let format: UInt
      let channels: UInt32
      let interleaved: Bool
      let readable: Bool
      let peak: Float
      let voiced: Bool
      let onset: Bool
    }
  #endif

  /// The render callback reads bounded energy only. It never transfers PCM,
  /// performs network work, or changes track volume on the realtime callback.
  private final class VoiceSpeechRenderer: AudioRenderer {
    private struct State {
      var onsetTracker = VoiceOnsetTracker()
      var readableCapture = false
      #if DEBUG
        var callbacks = 0
        var frames = 0
        var peak: Float = 0
        var voiced = false
        var onset = false
        var reports = 0
      #endif
    }
    private let state = OSAllocatedUnfairLock(initialState: State())
    private let started: @Sendable (VoiceOnsetNotice) -> Void
    #if DEBUG
      // One initial report plus 31 two-second windows covers the 60-second
      // qualification baseline. Only explicit debug UI-test namespaces attach
      // this scalar diagnostic; no PCM leaves the realtime callback.
      private static let maxCaptureEvidenceReports = 32
      private let diagnostic: (@Sendable (VoiceCaptureEvidence) -> Void)?
      init(
        started: @escaping @Sendable (VoiceOnsetNotice) -> Void,
        diagnostic: @escaping @Sendable (VoiceCaptureEvidence) -> Void
      ) {
        self.started = started
        self.diagnostic = diagnostic
      }
    #endif
    init(started: @escaping @Sendable (VoiceOnsetNotice) -> Void) {
      self.started = started
      #if DEBUG
        diagnostic = nil
      #endif
    }
    func resetOnset() {
      let epoch = UUID()
      state.withLock {
        $0.onsetTracker.reset(epoch: epoch)
        $0.readableCapture = false
      }
    }
    var hasReadableCapture: Bool { state.withLock { $0.readableCapture } }
    func acceptsOnset(_ notice: VoiceOnsetNotice) -> Bool {
      state.withLock { $0.onsetTracker.isCurrent(notice) }
    }
    func render(pcmBuffer: AVAudioPCMBuffer) {
      let count = min(Int(pcmBuffer.frameLength), 2048)
      guard count > 0 else { return }
      var peak: Float = 0
      if let data = pcmBuffer.floatChannelData?[0] {
        for i in 0..<count { peak = max(peak, abs(data[i])) }
      } else if let data = pcmBuffer.int16ChannelData?[0] {
        for i in 0..<count { peak = max(peak, abs(Float(data[i])) / 32768) }
      }
      let energy = peak
      let onset = state.withLock { value in
        value.readableCapture =
          value.readableCapture || pcmBuffer.floatChannelData != nil
          || pcmBuffer.int16ChannelData != nil
        return value.onsetTracker.process(
          peak: energy, frameCount: Int(pcmBuffer.frameLength),
          sampleRate: pcmBuffer.format.sampleRate)
      }
      if let onset { started(onset) }
      #if DEBUG
        if let diagnostic {
          let frames = Int(pcmBuffer.frameLength)
          let sampleRate = pcmBuffer.format.sampleRate
          let format = pcmBuffer.format.commonFormat.rawValue
          let channels = pcmBuffer.format.channelCount
          let interleaved = pcmBuffer.format.isInterleaved
          let readable = pcmBuffer.floatChannelData != nil || pcmBuffer.int16ChannelData != nil
          let report = state.withLock { value -> VoiceCaptureEvidence? in
            guard value.reports < Self.maxCaptureEvidenceReports else { return nil }
            value.callbacks += 1
            value.frames += frames
            value.peak = max(value.peak, energy)
            value.voiced = value.voiced || energy >= 0.025
            value.onset = value.onset || onset != nil
            guard value.callbacks == 1 || Double(value.frames) >= sampleRate * 2 else { return nil }
            value.reports += 1
            let report = VoiceCaptureEvidence(
              callbacks: value.callbacks, frames: value.frames,
              sampleRate: sampleRate, format: format, channels: channels, interleaved: interleaved,
              readable: readable, peak: value.peak, voiced: value.voiced, onset: value.onset)
            value.frames = 0
            value.peak = 0
            value.voiced = false
            value.onset = false
            return report
          }
          if let report { diagnostic(report) }
        }
      #endif
    }
  }

  /// SDK delegates are Sendable and nonisolated; only immutable callbacks cross
  /// the SDK queue. The media owner checks room generation on the MainActor hop.
  private final class VoiceRoomDelegate: RoomDelegate {
    let failure: @Sendable () -> Void
    let publication: @Sendable (RemoteParticipant, RemoteTrackPublication) -> Void
    init(
      failure: @escaping @Sendable () -> Void,
      publication: @escaping @Sendable (RemoteParticipant, RemoteTrackPublication) -> Void
    ) {
      self.failure = failure
      self.publication = publication
    }
    func room(
      _ room: Room, participant: RemoteParticipant,
      didPublishTrack publication: RemoteTrackPublication
    ) {
      self.publication(participant, publication)
    }
    func room(
      _ room: Room, participant: RemoteParticipant,
      didSubscribeTrack publication: RemoteTrackPublication
    ) {
      self.publication(participant, publication)
    }
    func room(_ room: Room, didDisconnectWithError error: LiveKitError?) {
      failure()
    }
    func room(_ room: Room, didFailToConnectWithError error: LiveKitError?) { failure() }
    func room(_ room: Room, didStartReconnectWithMode reconnectMode: ReconnectMode) { failure() }
    func room(_ room: Room, didCompleteReconnectWithMode reconnectMode: ReconnectMode) {
      // Completion from this retired attempt cannot restore a newer capture.
    }
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
