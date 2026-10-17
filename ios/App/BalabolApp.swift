import SwiftUI

@main
struct BalabolApp: App {
  private let localState = ClientLocalState.currentLaunch()
  var body: some Scene {
    WindowGroup { ConversationRoot(localState: localState) }
  }
}

/// The composition root selects a private namespace only for explicit debug UI
/// test launches. Ordinary app launches always keep the same saved local state.
private struct ClientLocalState {
  let defaults: UserDefaults
  let testNamespace: String?
  let launchControlURL: String?
  let voiceDiagnostics: Bool

  static func currentLaunch() -> ClientLocalState {
    #if DEBUG
      if let value = ProcessInfo.processInfo.environment["BALABOL_UI_TEST_NAMESPACE"] {
        guard let namespace = UUID(uuidString: value)?.uuidString,
          let defaults = UserDefaults(suiteName: "app.balabol.uitests." + namespace)
        else { preconditionFailure("The UI test namespace must be a UUID.") }
        return ClientLocalState(
          defaults: defaults, testNamespace: namespace,
          launchControlURL: ProcessInfo.processInfo.environment["BALABOL_UI_TEST_CONTROL_URL"],
          voiceDiagnostics: true)
      }
    #endif
    #if DEBUG
      let voiceDiagnostics = ProcessInfo.processInfo.environment["BALABOL_VOICE_DIAGNOSTICS"] != "0"
    #else
      let voiceDiagnostics = false
    #endif
    return ClientLocalState(
      defaults: .standard, testNamespace: nil, launchControlURL: nil,
      voiceDiagnostics: voiceDiagnostics)
  }

  func draftURL(in applicationSupport: URL) -> URL {
    guard let testNamespace else {
      return applicationSupport.appendingPathComponent("conversation-draft.json")
    }
    return applicationSupport.appendingPathComponent("UITests", isDirectory: true)
      .appendingPathComponent(testNamespace, isDirectory: true)
      .appendingPathComponent("conversation-draft.json")
  }
}

@MainActor private final class VoiceInputIntentRelay {
  weak var voice: VoiceViewModel?
  func send(_ id: UUID) { voice?.inputIntent(id) }
  func cue(_ input: UUID, _ response: UUID, _ cue: ConversationGenerationCue) {
    voice?.generationCue(input: input, response: response,
      cue: cue == .generationStarted ? .generationStarted : .textReady)
  }
  func cancelCue() { voice?.cancelGenerationCue() }
}

@MainActor
private struct ConversationRoot: View {
  @AppStorage private var configuredURL: String
  @State private var urlInput = ""
  @State private var model: ConversationViewModel?
  @State private var voice: VoiceViewModel?
  @State private var session: URLSession?
  @State private var configurationError: String?
  @State private var showingServer = false
  @State private var switchingServer = false
  private let localState: ClientLocalState

  init(localState: ClientLocalState) {
    self.localState = localState
    _configuredURL = AppStorage(wrappedValue: "", "serverURL", store: localState.defaults)
  }

  var body: some View {
    NavigationStack {
      Group {
        if let model {
          ConversationView(model: model) {
            if let voice { VoiceView(model: voice) }
          } details: {
            if let voice { VoiceDetailsView(model: voice) }
          }
          // A replacement model must start fresh view-owned lifecycle tasks.
          .id(ObjectIdentifier(model))
        } else {
          serverForm
            .navigationTitle("Connect to Balabol")
        }
      }
      .disabled(switchingServer)
      .toolbar {
        if model != nil {
          Button {
            urlInput = configuredURL
            configurationError = nil
            showingServer = true
          } label: {
            Label("Server", systemImage: "server.rack")
              .frame(minWidth: 44, minHeight: 44)
          }
          .disabled(model?.canSwitchServer != true || voice?.state.canSwitchServer == false)
        }
      }
    }
    .tint(Color(uiColor: .systemIndigo))
    .sheet(isPresented: $showingServer) {
      NavigationStack {
        serverForm
          .navigationTitle("Server")
          .navigationBarTitleDisplayMode(.inline)
          .toolbar {
            ToolbarItem(placement: .cancellationAction) {
              Button("Cancel") { showingServer = false }
                .disabled(switchingServer)
            }
          }
      }
      .interactiveDismissDisabled(switchingServer)
    }
    .onAppear {
      guard model == nil else { return }
      if let launchControlURL = localState.launchControlURL {
        urlInput = launchControlURL
        connect()
        return
      }
      urlInput = configuredURL
      if !configuredURL.isEmpty {
        connect()
      } else if localState.testNamespace == nil,
        let bundledOrigin = Bundle.main.object(forInfoDictionaryKey: "BalabolDefaultControlURL")
          as? String,
        !bundledOrigin.isEmpty
      {
        urlInput = bundledOrigin
        connect()
      } else {
        #if targetEnvironment(simulator)
          urlInput = "http://127.0.0.1:8787"
          connect()
        #endif
      }
    }
  }
  private var serverForm: some View {
    Form {
      Section {
        Label("Your conversation, on your Mac", systemImage: "desktopcomputer")
          .font(.headline)
        Text("Connect Balabol to the server where your conversation is stored.")
          .foregroundStyle(.primary.opacity(0.75))
      }
      Section {
        TextField("https://your-mac:8444", text: $urlInput)
          .accessibilityLabel("Server address")
          .accessibilityIdentifier("server-url")
          .textContentType(.URL)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .keyboardType(.URL)
          .disabled(switchingServer)
        if let configurationError {
          Label(configurationError, systemImage: "exclamationmark.circle")
            .font(.callout).accessibilityIdentifier("server-error")
        }
      } header: {
        Text("Server address")
      } footer: {
        Text(
          "On iPhone, use your Mac’s private Tailscale HTTPS address, including port 8444. On Simulator, use http://127.0.0.1:8787."
        )
      }
      Section {
        Button {
          if model == nil { connect() } else { Task { await changeServer() } }
        } label: {
          HStack {
            if switchingServer { ProgressView() }
            Text(switchingServer ? "Connecting…" : "Connect")
              .frame(maxWidth: .infinity, minHeight: 44)
          }
        }
        .buttonStyle(.borderedProminent)
        .disabled(
          urlInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || switchingServer)
      } footer: {
        Text(
          "Keep the server running on your Mac. Connecting selects its address; it doesn’t start the server."
        )
      }
    }
  }

  private func changeServer() async {
    guard !switchingServer, let current = model, current.canSwitchServer,
      voice?.state.canSwitchServer != false
    else { return }
    // Validate before retiring the current connection; Cancel never changes it.
    let validationSession = URLSession(configuration: .ephemeral)
    defer { validationSession.invalidateAndCancel() }
    do {
      guard let url = URL(string: urlInput) else { throw ConversationFailure.invalidInput }
      _ = try HTTPConversationTransport(baseURL: url, session: validationSession)
    } catch {
      configurationError = "Enter a valid HTTP or HTTPS server URL without credentials or a path."
      return
    }
    if urlInput == configuredURL {
      showingServer = false
      return
    }
    switchingServer = true
    await voice?.shutdown()
    voice = nil
    await current.shutdown()
    session?.invalidateAndCancel()
    session = nil
    model = nil
    connect()
    switchingServer = false
    showingServer = model == nil
  }

  private func connect() {
    // Live connections are retired only through the awaited Server action.
    guard model == nil, session == nil else { return }
    do {
      guard let url = URL(string: urlInput) else { throw ConversationFailure.invalidInput }
      let configuration = HTTPConversationTransport.sessionConfiguration()
      let candidate = URLSession(configuration: configuration)
      let transport: HTTPConversationTransport
      do {
        transport = try HTTPConversationTransport(
          baseURL: url, session: candidate,
          diagnosticsEnabled: localState.voiceDiagnostics)
      } catch {
        candidate.invalidateAndCancel()
        throw error
      }
      let directory = try FileManager.default.url(
        for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
      let draftStore = FileDraftStore(
        url: localState.draftURL(in: directory))
      let inputRelay = VoiceInputIntentRelay()
      let conversation = ConversationViewModel(
        transport: transport, draftStore: draftStore,
        diagnosticsEnabled: localState.voiceDiagnostics,
        inputIntent: { id in inputRelay.send(id) },
        generationCue: { input, response, cue in inputRelay.cue(input, response, cue) },
        cancelGenerationCue: { inputRelay.cancelCue() })
      let control = try HTTPVoiceControl(baseURL: url, session: candidate)
      let checkpointDirectory = localState.draftURL(in: directory).deletingLastPathComponent()
      let checkpoint = try FileVoiceAdmissionCheckpoint(
        url: FileVoiceAdmissionCheckpoint.fileURL(in: checkpointDirectory, controlOrigin: url),
        controlOrigin: url)
      voice = VoiceViewModel(
        control: control,
        media: LiveKitVoiceMedia(evidenceEnabled: localState.voiceDiagnostics),
        checkpoint: checkpoint,
        refreshConversation: { [weak conversation] in
          conversation?.refreshReconnectDisplay()
        },
        interruptConversation: { [weak conversation] inputs, stopped in
          conversation?.interruptForPlatform(handedInputIds: inputs, afterLocalStop: stopped)
        }
      ) {
        [weak conversation] receipt in
        conversation?.acceptVoiceReceipt(receipt)
      }
      inputRelay.voice = voice
      model = conversation
      session = candidate
      configuredURL = urlInput
      configurationError = nil
    } catch {
      configurationError = "Enter a valid HTTP or HTTPS server URL without credentials or a path."
    }
  }
}
