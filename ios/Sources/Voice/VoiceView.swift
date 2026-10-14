#if os(iOS)
  import SwiftUI
  #if canImport(Conversation)
    import Conversation
  #endif

  public struct VoiceView: View {
    @Bindable private var model: VoiceViewModel
    public init(model: VoiceViewModel) { self.model = model }
    public var body: some View {
      VStack(alignment: .leading, spacing: 4) {
        HStack(alignment: .firstTextBaseline) {
          Text(status).accessibilityIdentifier("voice-status")
          Spacer()
          Text("Scripted transcription").font(.caption).foregroundStyle(.secondary)
            .accessibilityIdentifier("scripted-transcription")
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
          Text("Please repeat the speech").font(.caption).foregroundStyle(.red)
        }
        if model.output.locallyInterrupted {
          Text("Interrupted").font(.caption)
        } else if model.output.unavailable {
          Text("Audio unavailable").font(.caption).accessibilityIdentifier(
            "voice-output-unavailable")
        } else if let output = model.output.current {
          if output.status == .playing && model.output.receivedAudio {
            Text("Playing fixture audio").font(.caption).accessibilityIdentifier(
              "voice-output-playing")
          } else if [.preparing, .awaitingReady, .playing].contains(output.status) {
            Text("Replying…").font(.caption).accessibilityIdentifier("voice-output-replying")
          }
        }
        HStack {
          if model.state.canStart {
            Button(model.state.capture == .idle ? "Start voice" : "Try again") { model.start() }
              .accessibilityIdentifier("start-voice")
          }
          if model.state.canResume {
            Button("Resume") { model.resume() }.accessibilityIdentifier("resume-voice")
          }
          if model.state.wantsListening {
            Button(model.state.wantsMuted ? "Unmute" : "Mute") { model.toggleMute() }
              .accessibilityIdentifier("mute-voice")
              .disabled(model.state.isChangingMute)
          }
          if [
            .requestingMicrophone, .connecting, .reconnecting, .hostUnavailable,
            .checkingPreviousSpeech, .listening, .muted, .paused, .resuming,
          ].contains(model.state.capture) {
            Button("End") { model.end() }.accessibilityIdentifier("end-voice")
          }
          if model.state.capture == .failed(.permissionDenied) {
            Button("Open Settings") {
              if let url = URL(string: UIApplication.openSettingsURLString) {
                UIApplication.shared.open(url)
              }
            }
          }
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal)
      .task {
        await model.restore()
        await model.loadLanguages()
      }
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
          Text("Scripted languages: " + languages.displayNames()).font(.caption)
            .foregroundStyle(.secondary).accessibilityIdentifier("voice-languages")
        }
        if let failure = model.state.languageFailure {
          Text(languageFailure(failure)).font(.caption).foregroundStyle(.secondary)
            .accessibilityIdentifier("voice-language-unavailable")
        }
        if model.output.locallyInterrupted {
          Text("Interrupted: generated text may include audio not heard").accessibilityIdentifier(
            "voice-output-interrupted")
        } else if model.output.unavailable {
          Text("Audio unavailable").accessibilityIdentifier("voice-output-unavailable-detail")
        } else if let output = model.output.current {
          if output.status == .playing && model.output.receivedAudio {
            Text("Playing fixture audio").accessibilityIdentifier("voice-output-playing-detail")
          } else if output.status == .preparing || output.status == .awaitingReady
            || output.status == .playing
          {
            Text("Replying…").accessibilityIdentifier("voice-output-replying-detail")
          }
        }
        if !model.state.tentative.isEmpty {
          Text("Tentative: \(model.state.tentative)").foregroundStyle(.secondary)
            .accessibilityIdentifier("voice-tentative")
        }
        ForEach(model.state.utterances, id: \.self) { id in
          if let admission = model.state.admissions[id] {
            if let spans = model.state.admissionLanguageSpans[id], !spans.isEmpty {
              Text(LanguageSpan.displayNames(spans)).font(.caption).foregroundStyle(.secondary)
                .accessibilityIdentifier("voice-input-languages")
            }
            switch admission {
            case .saving(_, let text):
              Text("Saving: \(text)").accessibilityIdentifier("voice-saving-detail")
            case .checking(_, let text):
              Text("Checking whether saved: \(text)").accessibilityIdentifier(
                "voice-checking-detail")
            case .failed(let text, _):
              Text("Please repeat the speech: \(text)").foregroundStyle(.red)
            case .saved: Text("Voice message saved").accessibilityIdentifier("voice-saved-detail")
            }
          }
        }
        if model.state.admissionFailure != nil && model.state.hasPendingAdmission {
          Text("Unable to check whether previous speech was saved")
            .foregroundStyle(.secondary).accessibilityIdentifier(
              "voice-admission-unavailable-detail")
        }
      }.frame(maxWidth: .infinity, alignment: .leading)
    }
    private func languageFailure(_ failure: VoiceFailure) -> String {
      if case .backend(let code, let message) = failure,
        ["InvalidLanguageConfiguration", "UnsupportedLanguage"].contains(code)
      {
        return "Scripted language configuration unavailable: " + message
      }
      return "Scripted language capabilities unavailable"
    }
  }
#endif
