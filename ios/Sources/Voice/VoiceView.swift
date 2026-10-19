#if os(iOS)
  import SwiftUI
  #if canImport(Conversation)
    import Conversation
  #endif

  public struct VoiceView: View {
    @Bindable private var model: VoiceViewModel
    public init(model: VoiceViewModel) { self.model = model }
    public var body: some View {
      VStack(alignment: .leading, spacing: 12) {
        VStack(alignment: .leading, spacing: 4) {
          Text("Voice").font(.subheadline).foregroundStyle(.primary.opacity(0.75))
            .accessibilityIdentifier("voice-conversation")
            .fixedSize(horizontal: false, vertical: true)
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(status).font(.headline).accessibilityIdentifier("voice-status")
              .fixedSize(horizontal: false, vertical: true)
            if isBusy {
              ProgressView().controlSize(.small).accessibilityHidden(true)
            }
          }
        }
        if let inputNotice = model.state.inputNotice,
          model.state.capture == .listening || model.state.capture == .muted
        {
          Text(inputNotice.message).font(.caption)
            .accessibilityIdentifier("voice-recognition-repeat")
        }
        if model.state.admissionFailure != nil && model.state.hasPendingAdmission {
          Text("Saved speech check unavailable").font(.caption)
            .accessibilityIdentifier("voice-admission-unavailable")
        } else if model.state.admissions.values.contains(where: {
          if case .checking = $0 { return true }
          return false
        }) {
          Text("Checking whether speech was saved…").font(.caption)
            .accessibilityIdentifier("voice-checking")
        } else if model.state.admissions.values.contains(where: {
          if case .saving = $0 { return true }
          return false
        }) {
          Text("Saving speech…").font(.caption).accessibilityIdentifier("voice-saving")
        } else if case .saved = model.state.admission {
          Text("Voice message saved").font(.caption).accessibilityIdentifier("voice-saved")
        } else if case .failed = model.state.admission {
          Text("Please repeat the speech").font(.caption).foregroundStyle(.primary)
        }
        if model.output.locallyInterrupted {
          Text("Interrupted").font(.caption)
        } else if model.output.unavailable {
          Text(model.output.current?.error?.message ?? "Audio unavailable").font(.caption).accessibilityIdentifier(
            "voice-output-unavailable")
        } else if let output = model.output.current {
          if output.status == .playing && model.output.receivedAudio {
            Text("Playing audio").font(.caption).accessibilityIdentifier(
              "voice-output-playing")
          } else if [.preparing, .awaitingReady, .playing].contains(output.status) {
            Text("Replying…").font(.caption).accessibilityIdentifier("voice-output-replying")
          }
        }
        ViewThatFits(in: .horizontal) {
          HStack(spacing: 12) {
            primaryControls
            Spacer(minLength: 12)
            endControl
          }
          VStack(alignment: .leading, spacing: 12) {
            primaryControls
            endControl
          }
        }
      }
      .fixedSize(horizontal: false, vertical: true)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(16)
      .background(
        Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16)
      )
      .task {
        await model.restore()
        await model.loadLanguages()
      }
    }
    @ViewBuilder private var primaryControls: some View {
      if model.state.canStart && model.state.capture != .failed(.permissionDenied) {
        Button(model.state.capture == .idle ? "Start voice" : "Try again") { model.start() }
          .buttonStyle(.borderedProminent)
          .controlSize(.large)
          .frame(minWidth: 44, minHeight: 44)
          .accessibilityIdentifier("start-voice")
      }
      if model.state.canResume {
        Button("Resume") { model.resume() }
          .buttonStyle(.borderedProminent)
          .controlSize(.large)
          .frame(minWidth: 44, minHeight: 44)
          .accessibilityIdentifier("resume-voice")
      }
      if model.state.wantsListening {
        Button(model.state.wantsMuted ? "Unmute" : "Mute") { model.toggleMute() }
          .buttonStyle(.bordered)
          .controlSize(.large)
          .frame(minWidth: 44, minHeight: 44)
          .accessibilityIdentifier("mute-voice")
          .disabled(model.state.isChangingMute)
      }
      if model.state.capture == .failed(.permissionDenied) {
        Button("Open Settings") {
          if let url = URL(string: UIApplication.openSettingsURLString) {
            UIApplication.shared.open(url)
          }
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .frame(minWidth: 44, minHeight: 44)
      }
    }
    @ViewBuilder private var endControl: some View {
      if [
        .requestingMicrophone, .connecting, .reconnecting, .hostUnavailable,
        .checkingPreviousSpeech, .listening, .muted, .paused, .resuming,
      ].contains(model.state.capture) {
        Button("End") { model.end() }
          .buttonStyle(.bordered)
          .controlSize(.large)
          .frame(minWidth: 44, minHeight: 44)
          .accessibilityLabel("End voice session")
          .accessibilityIdentifier("end-voice")
      }
    }
    private var isBusy: Bool {
      model.state.isChangingMute
        || [
          .requestingMicrophone, .connecting, .reconnecting, .hostUnavailable,
          .checkingPreviousSpeech, .resuming, .ending,
        ].contains(model.state.capture)
    }
    private var status: String {
      if model.state.hasPendingAdmission && model.state.wantsListening,
        [.hostUnavailable, .reconnecting, .checkingPreviousSpeech].contains(model.state.capture)
      {
        return "Checking previous speech…"
      }
      if model.state.isChangingMute { return "Changing microphone…" }
      return switch model.state.capture {
      case .idle: "Voice is off"
      case .requestingMicrophone: "Requesting microphone…"
      case .connecting: "Connecting microphone…"
      case .reconnecting: "Reconnecting…"
      case .hostUnavailable: "Host unavailable · reconnecting…"
      case .checkingPreviousSpeech: "Checking previous speech…"
      case .listening: "Listening"
      case .muted: "Microphone muted"
      case .paused: "Voice interrupted. Resume when you’re ready."
      case .resuming: "Resuming voice…"
      case .ending: "Ending voice…"
      case .ended: "Voice ended"
      case .failed(.permissionDenied): "Microphone permission denied"
      case .failed(.capture): "Microphone capture failed"
      case .failed(.connection): "Voice connection failed"
      case .failed: "Voice unavailable"
      }
    }
  }

  /// Variable voice details belong in the host's flexible transcript list.
  /// The app composition root supplies this view without a Conversation→Voice dependency.
  public struct VoiceDetailsView: View {
    @Bindable private var model: VoiceViewModel
    public init(model: VoiceViewModel) { self.model = model }
    public var body: some View {
      VStack(alignment: .leading, spacing: 6) {
        if let languages = model.state.languages {
          Text("Voice languages: " + languages.displayNames()).font(.caption)
            .foregroundStyle(.primary.opacity(0.75)).accessibilityIdentifier("voice-languages")
        }
        if let failure = model.state.languageFailure {
          Text(languageFailure(failure)).font(.caption).foregroundStyle(.primary.opacity(0.75))
            .accessibilityIdentifier("voice-language-unavailable")
        }
        if model.output.locallyInterrupted {
          Text("Interrupted: generated text may include audio not heard").accessibilityIdentifier(
            "voice-output-interrupted")
        }
        if !model.state.tentative.isEmpty {
          Text("Recognizing: \(model.state.tentative)").foregroundStyle(.primary.opacity(0.75))
            .accessibilityIdentifier("voice-tentative")
        }
        ForEach(model.state.utterances, id: \.self) { id in
          if let admission = model.state.admissions[id] {
            if let spans = model.state.admissionLanguageSpans[id], !spans.isEmpty {
              Text(LanguageSpan.displayNames(spans)).font(.caption).foregroundStyle(
                .primary.opacity(0.75)
              )
              .accessibilityIdentifier("voice-input-languages")
            }
            switch admission {
            case .saving(_, let text):
              Text("Saving: \(text)").accessibilityIdentifier("voice-saving-detail")
            case .checking(_, let text):
              Text("Checking whether saved: \(text)").accessibilityIdentifier(
                "voice-checking-detail")
            case .failed(let text, _):
              Text("Please repeat the speech: \(text)").foregroundStyle(.primary)
            case .saved: EmptyView()
            }
          }
        }
        if model.state.admissionFailure != nil && model.state.hasPendingAdmission {
          Text("Unable to check whether previous speech was saved")
            .foregroundStyle(.primary.opacity(0.75)).accessibilityIdentifier(
              "voice-admission-unavailable-detail")
        }
      }.frame(maxWidth: .infinity, alignment: .leading)
    }
    private func languageFailure(_ failure: VoiceFailure) -> String {
      if case .backend(let code, let message) = failure,
        ["InvalidLanguageConfiguration", "UnsupportedLanguage"].contains(code)
      {
        return "Voice languages couldn’t load: " + message
      }
      return "Voice languages couldn’t load."
    }
  }
#endif
