#if os(iOS)
  @preconcurrency import AVFoundation
  import LiveKit
  import Foundation
  import os
  import UIKit

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
    private let generationCue = VoiceGenerationCueRenderer()
    private var outputReceived: (@Sendable (VoiceOutputIdentity) -> Void)?
    private var outputPublication: RemoteTrackPublication?
    private var microphone: LocalAudioTrack?
    private var renderer: VoiceSpeechRenderer?
    private var captureStopTask: Task<Void, Never>?
    private var speechTask: Task<Void, Never>?
    private var captureFailureCallback: (@Sendable () -> Void)?
    private var speechStartedCallback: (@MainActor @Sendable () -> Void)?
    #if DEBUG
      private var captureEvidenceTask: Task<Void, Never>?
      private var diagnosticBudget = VoiceAudioDiagnosticBudget()
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
        if evidenceEnabled {
          VoiceTransitionTrace.shared.configure(
            destination:
              FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
              .appendingPathComponent("balabol-voice-transitions.json"))
          print(
            "[BALABOL-AUDIO] {\"stage\":\"diagnostics-enabled\",\"uptimeSeconds\":\(ProcessInfo.processInfo.systemUptime)}"
          )
        }
      #else
        self.evidenceEnabled = false
      #endif
      LiveKitSDK.disableLogging()
    }
    private func audioDiagnostic(
      _ stage: String, levels: VoiceAudioLevels? = nil, periodic: Bool = false
    ) {
      #if DEBUG
        guard evidenceEnabled, diagnosticBudget.admit(stage, periodic: periodic) else { return }
        // SDK readbacks synchronously wait for WebRTC's worker/signaling threads.
        // Run them off MainActor and never from an AudioRenderer callback.
        Task.detached(priority: .utility) {
          let record = VoiceAudioProcessingSnapshot.read(stage: stage, levels: levels)
          VoiceAudioProcessingTrace.shared.record(record)
          do {
            let data = try JSONEncoder().encode(record)
            print("[BALABOL-AUDIO] " + String(decoding: data, as: UTF8.self))
          } catch {
            VoiceAudioProcessingTrace.shared.reportEncodingFailure()
          }
        }
      #endif
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
      platformObservers.append(
        center.addObserver(
          forName: AVAudioSession.routeChangeNotification,
          object: AVAudioSession.sharedInstance(), queue: nil
        ) { [weak self] _ in
          Task { @MainActor in
            guard let self, self.observationEpoch == epoch else { return }
            self.renderer?.resetOnset()
          }
        })
      #if DEBUG
        if evidenceEnabled {
          for (name, stage) in [
            (UIApplication.protectedDataWillBecomeUnavailableNotification, "protected-data-locked"),
            (UIApplication.protectedDataDidBecomeAvailableNotification, "protected-data-unlocked"),
            (UIApplication.didEnterBackgroundNotification, "app-background"),
            (UIApplication.didBecomeActiveNotification, "app-active"),
          ] {
            platformObservers.append(
              center.addObserver(forName: name, object: nil, queue: nil) { [weak self] _ in
                Task { @MainActor in
                  guard let self, self.observationEpoch == epoch, self.room != nil else { return }
                  VoiceTransitionTrace.shared.record(.lifecycle, status: stage)
                  self.audioDiagnostic(stage)
                }
              })
          }
        }
      #endif
      func add(
        _ name: Notification.Name, decode: @escaping @Sendable (Notification) -> VoicePlatformEvent?
      ) {
        platformObservers.append(
          center.addObserver(forName: name, object: AVAudioSession.sharedInstance(), queue: nil) {
            notice in
            if let event = decode(notice) { deliver(event) }
          })
      }
      #if DEBUG
        if evidenceEnabled {
          for (name, stage) in [
            (AVAudioSession.routeChangeNotification, "route-change"),
            (AVAudioSession.interruptionNotification, "session-interruption"),
            (AVAudioSession.mediaServicesWereLostNotification, "services-lost"),
            (AVAudioSession.mediaServicesWereResetNotification, "services-reset"),
          ] {
            platformObservers.append(
              center.addObserver(forName: name, object: AVAudioSession.sharedInstance(), queue: nil)
              { [weak self] _ in
                Task { @MainActor in
                  guard let self, self.observationEpoch == epoch, self.room != nil else { return }
                  self.audioDiagnostic(stage)
                }
              })
          }
        }
      #endif
      if #available(iOS 27.0, *) {
        #if DEBUG
          if evidenceEnabled {
            for (name, stage) in [
              (AVAudioSession.didBecomeInactiveNotification, "session-inactive"),
              (AVAudioSession.resumptionRecommendationNotification, "session-resume-recommended"),
            ] {
              platformObservers.append(
                center.addObserver(
                  forName: name,
                  object: AVAudioSession.sharedInstance(), queue: nil
                ) { [weak self] _ in
                  Task { @MainActor in
                    guard let self, self.observationEpoch == epoch, self.room != nil else { return }
                    self.audioDiagnostic(stage)
                  }
                })
            }
          }
        #endif
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
      audioDiagnostic("microphone-stop-requested")
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
      if AudioManager.shared.renderPreProcessingDelegate == nil {
        AudioManager.shared.renderPreProcessingDelegate = generationCue
      }
      self.outputReceived = outputReceived
      speechStartedCallback = speechStarted
      captureFailureCallback = failure
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
            try await installMicrophone(track, generation: expected, speechStarted: speechStarted)
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
        if renderer?.hasReadableCapture == true {
          audioDiagnostic("microphone-started")
          return
        }
        try await Task.sleep(for: .milliseconds(50))
      }
      throw VoiceFailure.capture
    }
    private func installMicrophone(
      _ track: LocalAudioTrack, generation expected: Int,
      speechStarted: @escaping @MainActor @Sendable () -> Void
    ) async throws {
      guard microphone !== track else { return }
      let classifier = try await Task.detached(priority: .userInitiated) {
        try SileroVoiceClassifier.bundled()
      }.value
      guard generation == expected, !Task.isCancelled else { throw CancellationError() }
      speechTask?.cancel()
      if let microphone, let renderer { microphone.remove(audioRenderer: renderer) }
      microphone = track
      let stream = AsyncStream<VoiceCaptureEvent>.makeStream(bufferingPolicy: .bufferingNewest(8))
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
              self?.audioDiagnostic(
                "capture-window",
                levels: VoiceAudioLevels(
                  rms: value.rms, peak: value.peak, frames: value.frames,
                  onset: nil), periodic: true)
              logger.notice(
                "capture callbacks=\(value.callbacks, privacy: .public) frames=\(value.frames, privacy: .public) sampleRate=\(value.sampleRate, privacy: .public) format=\(value.format, privacy: .public) channels=\(value.channels, privacy: .public) interleaved=\(value.interleaved, privacy: .public) readable=\(value.readable, privacy: .public) peak=\(value.peak, privacy: .public) rms=\(value.rms, privacy: .public) classification=separate"
              )
            }
          }
          renderer = VoiceSpeechRenderer(
            classifier: classifier, failed: { stream.continuation.yield(.failed($0)) },
            started: { stream.continuation.yield(.speech($0)) },
            diagnostic: { evidence.continuation.yield($0) })
        } else {
          renderer = VoiceSpeechRenderer(
            classifier: classifier, failed: { stream.continuation.yield(.failed($0)) },
            started: { stream.continuation.yield(.speech($0)) })
        }
      #else
        renderer = VoiceSpeechRenderer(
          classifier: classifier, failed: { stream.continuation.yield(.failed($0)) },
          started: { stream.continuation.yield(.speech($0)) })
      #endif
      self.renderer = renderer
      track.add(audioRenderer: renderer)
      speechTask = Task { [weak self] in
        for await event in stream.stream {
          guard !Task.isCancelled, let self, self.generation == expected else { return }
          switch event {
          case .speech(let notice):
            guard renderer.acceptsOnset(notice) else {
              #if DEBUG
                VoiceTransitionTrace.shared.record(.onsetRejected, microphone: notice.epoch)
              #endif
              continue
            }
            #if DEBUG
              VoiceTransitionTrace.shared.record(.onsetAccepted, microphone: notice.epoch)
            #endif
            self.audioDiagnostic("speech-qualified")
            speechStarted()
          case .failed(let epoch):
            guard renderer.acceptsFailure(epoch) else { continue }
            #if DEBUG
              VoiceTransitionTrace.shared.record(
                .captureFailure, microphone: epoch, status: renderer.failureCode?.traceStatus)
            #endif
            self.audioDiagnostic("speech-classifier-failed")
            self.captureFailureCallback?()
          }
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
          try await installMicrophone(
            track, generation: expected, speechStarted: speechStartedCallback)
          try await awaitCapture(generation: expected)
        }
      } catch { throw VoiceFailure.capture }
    }
    public func disconnect() async {
      generationCue.cancel()
      if AudioManager.shared.renderPreProcessingDelegate === generationCue {
        AudioManager.shared.renderPreProcessingDelegate = nil
      }
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
      await renderer?.shutdown()
      microphone = nil
      renderer = nil
      speechStartedCallback = nil
      captureFailureCallback = nil
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
              let renderer = VoicePlaybackRenderer(
                evidenceEnabled: evidenceEnabled,
                diagnostic: { [weak self] levels in
                  Task { @MainActor in
                    guard let self, self.generation == expected, self.wanted == manifest else {
                      return
                    }
                    self.audioDiagnostic("playback-first-nonzero", levels: levels)
                  }
                }
              ) {
                callback?(manifest.identity)
              }
              playbackRenderer = renderer
              track.add(audioRenderer: renderer)
            }
            outputTrack = track
            audioDiagnostic("playout-prepared")
            #if DEBUG
              VoiceTransitionTrace.shared.record(.playoutPrepared, target: manifest.identity)
            #endif
            return
          }
        }
        try await Task.sleep(for: .milliseconds(50))
      }
      throw VoiceFailure.connection
    }
    public func playCue(_ cue: VoiceProgressCue) {
      guard room != nil, AudioManager.shared.renderPreProcessingDelegate === generationCue else {
        os.Logger(subsystem: "app.balabol.voice", category: "progress-cue")
          .error("Progress cue unavailable: managed render processor is not installed")
        return
      }
      generationCue.play(cue)
    }
    public func cancelCue() { generationCue.cancel() }

    public func stopOutput() -> Task<Void, Never> {
      generationCue.cancel()
      #if DEBUG
        let manifest = wanted
      #endif
      wanted = nil
      let track = outputTrack
      if track != nil { audioDiagnostic("playout-stop-requested") }
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
            audioDiagnostic("playout-stopped")
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

  private typealias VoiceAudioLevels = VoiceAudioProcessingSnapshot.Levels
  #if DEBUG
    extension VoiceAudioProcessingSnapshot {
      fileprivate static func read(stage: String, levels: VoiceAudioLevels?) -> Self {
        let manager = AudioManager.shared
        let processing = manager.audioProcessingState.echoCancellation
        let platform = manager.platformVoiceProcessingState
        let session = AVAudioSession.sharedInstance()
        return Self(
          stage: stage, uptimeSeconds: ProcessInfo.processInfo.systemUptime,
          category: session.category.rawValue, mode: session.mode.rawValue,
          inputPortTypes: session.currentRoute.inputs.prefix(4).map { $0.portType.rawValue },
          outputPortTypes: session.currentRoute.outputs.prefix(4).map { $0.portType.rawValue },
          sampleRate: session.sampleRate, ioDurationSeconds: session.ioBufferDuration,
          requestedAEC: processing.requested?.isEnabled,
          requestedAECMode: processing.requested.map { String(describing: $0.mode) },
          effectiveAEC: processing.effective.description,
          softwareAECResolved: processing.software.isResolved,
          softwareAECActive: processing.software.isActive,
          platformAECResolved: processing.platform?.isResolved,
          platformAECActive: processing.platform?.isActive,
          vpioEnabledRequested: platform.voiceProcessingEnabled.isRequested,
          vpioEnabledActive: platform.voiceProcessingEnabled.isActive,
          vpioBypassRequested: platform.voiceProcessingBypassed.isRequested,
          vpioBypassActive: platform.voiceProcessingBypassed.isActive, levels: levels)
      }
    }
  #endif

  private final class VoicePlaybackRenderer: AudioRenderer {
    private let reported = OSAllocatedUnfairLock(initialState: false)
    private let received: @Sendable () -> Void
    private let evidenceEnabled: Bool
    private let diagnostic: @Sendable (VoiceAudioLevels) -> Void
    init(
      evidenceEnabled: Bool, diagnostic: @escaping @Sendable (VoiceAudioLevels) -> Void,
      received: @escaping @Sendable () -> Void
    ) {
      self.diagnostic = diagnostic
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
          var squares = 0.0
          var peak: Float = 0
          for frame in 0..<count {
            let sample: Float
            if let data = pcmBuffer.floatChannelData?[0] {
              sample = data[frame]
            } else if let data = pcmBuffer.int16ChannelData?[0] {
              sample = Float(data[frame]) / 32768
            } else {
              continue
            }
            squares += Double(sample) * Double(sample)
            peak = max(peak, abs(sample))
          }
          diagnostic(
            VoiceAudioLevels(
              rms: Float(sqrt(squares / Double(count))), peak: peak,
              frames: count, onset: false))
          let logger = os.Logger(subsystem: "app.balabol.voice.evidence", category: "playback")
          logger.notice("remote audio received nonzero samples=\(count, privacy: .public)")
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
      let rms: Float
    }
  #endif

  /// The render callback reads bounded energy only. It never transfers PCM,
  /// performs network work, or changes track volume on the realtime callback.
  private enum VoiceCaptureEvent: Sendable {
    case speech(VoiceOnsetNotice)
    case failed(UUID)
  }
  private final class VoiceSpeechRenderer: AudioRenderer {
    private struct EvidenceState {
      var callbacks = 0
      var frames = 0
      var peak: Float = 0
      var squares = 0.0
      var reports = 0
    }
    private let evidence = OSAllocatedUnfairLock(initialState: EvidenceState())
    private let worker: VoiceActivityCapture
    #if DEBUG
      private let diagnostic: (@Sendable (VoiceCaptureEvidence) -> Void)?
      init(
        classifier: any VoiceActivityClassifier, failed: @escaping @Sendable (UUID) -> Void,
        started: @escaping @Sendable (VoiceOnsetNotice) -> Void,
        diagnostic: (@Sendable (VoiceCaptureEvidence) -> Void)? = nil
      ) {
        self.diagnostic = diagnostic
        worker = VoiceActivityCapture(
          classifier: classifier,
          started: { epoch, _ in started(VoiceOnsetNotice(epoch: epoch)) },
          failed: failed)
      }
    #else
      init(
        classifier: any VoiceActivityClassifier, failed: @escaping @Sendable (UUID) -> Void,
        started: @escaping @Sendable (VoiceOnsetNotice) -> Void
      ) {
        worker = VoiceActivityCapture(
          classifier: classifier,
          started: { epoch, _ in started(VoiceOnsetNotice(epoch: epoch)) },
          failed: failed)
      }
    #endif
    deinit { worker.close() }
    #if DEBUG
      var failureCode: VoiceActivityError? { worker.failureCode }
    #endif
    func resetOnset() { worker.reset() }
    func shutdown() async { await worker.stop() }
    func acceptsFailure(_ epoch: UUID) -> Bool { worker.acceptsFailure(epoch) }
    var hasReadableCapture: Bool { worker.isReadable }
    func acceptsOnset(_ notice: VoiceOnsetNotice) -> Bool { worker.accepts(notice.epoch) }
    func render(pcmBuffer: AVAudioPCMBuffer) {
      let frames = Int(pcmBuffer.frameLength)
      let channels = Int(pcmBuffer.format.channelCount)
      guard frames > 0, frames <= Int(pcmBuffer.frameCapacity) else { return }
      let interleaved = pcmBuffer.format.isInterleaved
      var squares = 0.0
      var peak: Float = 0
      let captured: Bool
      if pcmBuffer.format.commonFormat == .pcmFormatFloat32, let data = pcmBuffer.floatChannelData {
        captured = worker.capture(
          frameCount: frames, channels: channels, sampleRate: pcmBuffer.format.sampleRate
        ) { frame, channel in
          let value = interleaved ? data[0][frame * channels + channel] : data[channel][frame]
          squares += Double(value) * Double(value)
          peak = max(peak, abs(value))
          return value
        }
      } else if pcmBuffer.format.commonFormat == .pcmFormatInt16,
        let data = pcmBuffer.int16ChannelData
      {
        captured = worker.capture(
          frameCount: frames, channels: channels, sampleRate: pcmBuffer.format.sampleRate
        ) { frame, channel in
          let raw = interleaved ? data[0][frame * channels + channel] : data[channel][frame]
          let value = Float(raw) / 32768
          squares += Double(value) * Double(value)
          peak = max(peak, abs(value))
          return value
        }
      } else {
        return
      }
      #if DEBUG
        guard captured, let diagnostic else { return }
        let totalSquares = squares
        let maximumPeak = peak
        let report = evidence.withLock { value -> VoiceCaptureEvidence? in
          guard value.reports < 30 else { return nil }
          value.callbacks += 1
          value.frames += frames
          value.squares += totalSquares / Double(channels)
          value.peak = max(value.peak, maximumPeak)
          guard value.callbacks == 1 || Double(value.frames) >= pcmBuffer.format.sampleRate * 2
          else { return nil }
          value.reports += 1
          let report = VoiceCaptureEvidence(
            callbacks: value.callbacks, frames: value.frames,
            sampleRate: pcmBuffer.format.sampleRate, format: pcmBuffer.format.commonFormat.rawValue,
            channels: pcmBuffer.format.channelCount, interleaved: interleaved, readable: true,
            peak: value.peak, rms: Float(sqrt(value.squares / Double(value.frames))))
          value.frames = 0
          value.squares = 0
          value.peak = 0
          return report
        }
        if let report { diagnostic(report) }
      #else
        _ = captured
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
