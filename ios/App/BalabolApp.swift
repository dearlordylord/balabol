import SwiftUI

@main
struct BalabolApp: App {
  var body: some Scene {
    WindowGroup { ConversationRoot() }
  }
}

@MainActor
private struct ConversationRoot: View {
  @AppStorage("serverURL") private var configuredURL = ""
  @State private var urlInput = ""
  @State private var model: ConversationViewModel?
  @State private var session: URLSession?
  @State private var configurationError: String?
  var body: some View {
    NavigationStack {
      Group {
        if let model {
          ConversationView(model: model)
        } else {
          Form {
            Text("Enter your backend's Tailscale URL, including its port.")
            TextField("http://100.x.x.x:3000", text: $urlInput)
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
      if !configuredURL.isEmpty { connect() }
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
        url: directory.appendingPathComponent("conversation-draft.json"))
      model = ConversationViewModel(transport: transport, draftStore: draftStore)
      session = candidate
      configuredURL = urlInput
      configurationError = nil
    } catch {
      configurationError = "Enter a valid HTTP or HTTPS server URL without credentials or a path."
    }
  }
}
