#if canImport(SwiftUI)
  import SwiftUI

  public struct ConversationView: View {
    @Bindable private var model: ConversationViewModel
    public init(model: ConversationViewModel) { self.model = model }
    public var body: some View {
      VStack {
        List {
          ForEach(model.messages) { message in
            Text(message.text).accessibilityIdentifier("message-\(message.position)")
          }
          if model.nextAfter != nil {
            Button("Load more") { Task { await model.loadHistory() } }
              .disabled(model.isLoading)
          }
        }
        if let failure = model.failure {
          Text(description(failure)).foregroundStyle(.red)
            .accessibilityIdentifier("delivery-status")
        }
        if !model.draftStorageReady {
          Button("Reload saved draft") { model.reloadDraft() }
        }
        if !model.hasLoadedHistory {
          Button("Load conversation") { Task { await model.loadHistory() } }
            .disabled(model.isLoading)
        }
        TextField(
          "Message", text: Binding(get: { model.draft }, set: model.editDraft), axis: .vertical
        )
        .lineLimit(2...6)
        .textFieldStyle(.roundedBorder)
        .disabled(!model.draftStorageReady || model.pendingDelivery != nil || model.isSending)
        .accessibilityIdentifier("message-draft")
        Button(
          model.isSending
            ? "Sending…" : model.pendingDelivery == nil ? "Send" : "Retry same message"
        ) {
          Task { await model.send() }
        }
        .disabled(
          model.isSending || !model.draftStorageReady
            || model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        )
        .accessibilityIdentifier("send-message")
      }
      .padding()
      .navigationTitle("Conversation")
      .task { await model.loadHistory() }
    }
    private func description(_ failure: ConversationFailure) -> String {
      switch failure {
      case .invalidInput: "Enter a nonempty message up to 100,000 characters."
      case .invalidResponse:
        "Invalid server response. Your message is retained; retry the same message."
      case .unavailable:
        "Delivery is unconfirmed. Your message is retained; retry the same message."
      case .rejected(let code, _): "Delivery failed (\(code)). Your message is retained."
      case .draftStorageUnavailable: "Saved draft is unavailable. Reload it before sending."
      }
    }
  }
#endif
