#if os(iOS)
  import SwiftUI

  public struct VoiceView: View {
    @Bindable private var model: VoiceViewModel
    public init(model: VoiceViewModel) { self.model = model }
    public var body: some View {
      VStack(alignment: .leading, spacing: 6) {
        Text("Scripted transcription").font(.caption).foregroundStyle(.secondary)
          .accessibilityIdentifier("scripted-transcription")
        Text(status).accessibilityIdentifier("voice-status")
        if !model.state.tentative.isEmpty {
          Text("Tentative: \(model.state.tentative)").foregroundStyle(.secondary)
            .accessibilityIdentifier("voice-tentative")
        }
        ForEach(model.state.utterances, id: \.self) { id in
          if let admission = model.state.admissions[id] {
            switch admission {
            case .saving(_, let text):
              Text("Saving: \(text)").accessibilityIdentifier("voice-saving")
            case .checking(_, let text):
              Text("Checking whether saved: \(text)").accessibilityIdentifier("voice-checking")
            case .failed(let text, _): Text("Not saved: \(text)").foregroundStyle(.red)
            case .saved: Text("Voice message saved").accessibilityIdentifier("voice-saved")
            }
          }
        }
        HStack {
          if model.state.canStart {
            Button(model.state.capture == .idle ? "Start voice" : "Try again") { model.start() }
              .accessibilityIdentifier("start-voice")
          }
          if model.state.capture == .listening || model.state.capture == .muted {
            Button(model.state.capture == .muted ? "Unmute" : "Mute") { model.toggleMute() }
              .accessibilityIdentifier("mute-voice")
              .disabled(model.state.isChangingMute)
          }
          if [.requestingMicrophone, .connecting, .listening, .muted].contains(model.state.capture)
          {
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
    }
    private var status: String {
      if model.state.isChangingMute { return "Changing microphone…" }
      return switch model.state.capture {
      case .idle: "Voice is off"
      case .requestingMicrophone: "Requesting microphone…"
      case .connecting: "Connecting microphone…"
      case .listening: "Listening"
      case .muted: "Microphone muted"
      case .ending: "Ending voice…"
      case .ended: "Voice ended"
      case .failed(.permissionDenied): "Microphone permission denied"
      case .failed(.capture): "Microphone capture failed"
      case .failed(.connection): "Voice connection failed"
      case .failed: "Voice unavailable"
      }
    }
  }
#endif
