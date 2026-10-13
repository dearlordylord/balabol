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

  static func currentLaunch() -> ClientLocalState {
    #if DEBUG
      if let value = ProcessInfo.processInfo.environment["BALABOL_UI_TEST_NAMESPACE"] {
        guard let namespace = UUID(uuidString: value)?.uuidString,
          let defaults = UserDefaults(suiteName: "app.balabol.uitests." + namespace)
        else { preconditionFailure("The UI test namespace must be a UUID.") }
        return ClientLocalState(defaults: defaults, testNamespace: namespace)
      }
    #endif
    return ClientLocalState(defaults: .standard, testNamespace: nil)
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

@MainActor
private struct ConversationRoot: View {
  @AppStorage private var configuredURL: String
  @State private var urlInput = ""
  @State private var model: ConversationViewModel?
  @State private var session: URLSession?
  @State private var configurationError: String?
  private let localState: ClientLocalState

  init(localState: ClientLocalState) {
    self.localState = localState
    _configuredURL = AppStorage(wrappedValue: "", "serverURL", store: localState.defaults)
  }

  var body: some View {
    NavigationStack {
      Group {
        if let model {
          ConversationView(model: model)
        } else {
          Form {
            Text(
              "On Simulator, use http://127.0.0.1:8787. On iPhone, use your Mac's Tailscale address with port 8787."
            )
            TextField("http://127.0.0.1:8787", text: $urlInput)
              .accessibilityIdentifier("server-url")
              .textInputAutocapitalization(.never)
              .autocorrectionDisabled()
              .keyboardType(.URL)
            Button("Connect") { connect() }
            if let configurationError { Text(configurationError).foregroundStyle(.red) }
          }
          .navigationTitle("Connect to Balabol")
        }
      }
      .toolbar {
        if model != nil {
          Button("Server") {
            session?.invalidateAndCancel()
            session = nil
            model = nil
          }
          .disabled(
            model?.isSending == true || model?.pendingDelivery != nil
              || model?.draftStorageReady == false)
        }
      }
    }
    .onAppear {
      urlInput = configuredURL
      if !configuredURL.isEmpty {
        connect()
      } else {
        #if targetEnvironment(simulator)
          urlInput = "http://127.0.0.1:8787"
          connect()
        #endif
      }
    }
  }
  private func connect() {
    do {
      guard let url = URL(string: urlInput) else { throw ConversationFailure.invalidInput }
      let configuration = URLSessionConfiguration.ephemeral
      configuration.timeoutIntervalForRequest = 20
      configuration.timeoutIntervalForResource = 30
      let candidate = URLSession(configuration: configuration)
      let transport: HTTPConversationTransport
      do { transport = try HTTPConversationTransport(baseURL: url, session: candidate) } catch {
        candidate.invalidateAndCancel()
        throw error
      }
      let directory = try FileManager.default.url(
        for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
      let draftStore = FileDraftStore(
        url: localState.draftURL(in: directory))
      model = ConversationViewModel(transport: transport, draftStore: draftStore)
      session = candidate
      configuredURL = urlInput
      configurationError = nil
    } catch {
      configurationError = "Enter a valid HTTP or HTTPS server URL without credentials or a path."
    }
  }
}
