#if canImport(SwiftUI)
  import SwiftUI

  public struct ConversationView<Details: View>: View {
    @Environment(\.scenePhase) private var scenePhase
    @Bindable private var model: ConversationViewModel
    private let details: Details
    /// Composition supplies feature-owned details inside this single flexible
    /// list. Conversation does not acquire another feature's model or imports.
    public init(model: ConversationViewModel, @ViewBuilder details: () -> Details) {
      self.model = model
      self.details = details()
    }
    public var body: some View {
      VStack {
        ScrollViewReader { proxy in
          List {
            details
            Text("Demo provider · scripted replies").font(.caption).foregroundStyle(.secondary)
              .accessibilityIdentifier("demo-provider")
            ForEach(model.messages) { message in
              VStack(alignment: .leading) {
                HStack(alignment: .firstTextBaseline) {
                  Text(message.role == .user ? "You" : "Assistant").font(.caption)
                    .foregroundStyle(.secondary).fixedSize(horizontal: true, vertical: false)
                  if !message.languageSpans.isEmpty {
                    Text(LanguageSpan.displayNames(message.languageSpans)).font(.caption)
                      .foregroundStyle(.secondary)
                      .accessibilityIdentifier("message-languages-\(message.position)")
                  }
                }
                if message.outcome == .interrupted {
                  Text("Interrupted").font(.caption).foregroundStyle(.secondary)
                    .accessibilityIdentifier("interrupted-message-\(message.position)")
                }
                Text(
                  message.text.isEmpty && message.outcome == .interrupted
                    ? "Interrupted before a reply appeared" : message.text
                ).accessibilityIdentifier(
                  message.role == .assistant
                    ? "assistant-message-\(message.position)" : "message-\(message.position)")
              }
            }
            if model.replyIsWaiting || !model.replyText.isEmpty {
              VStack(alignment: .leading) {
                Text("Assistant").font(.caption).foregroundStyle(.secondary)
                if model.replyIsWaiting {
                  Text(
                    model.state.isRetryingReply
                      ? "Retrying reply…"
                      : "Preparing your reply…"
                  ).accessibilityIdentifier("reply-waiting")
                }
                if !model.state.replyLanguageSpans.isEmpty {
                  Text(LanguageSpan.displayNames(model.state.replyLanguageSpans)).font(.caption)
                    .foregroundStyle(.secondary).accessibilityIdentifier("reply-languages")
                }
                if !model.replyText.isEmpty {
                  Text(model.replyText).accessibilityIdentifier("reply-progress")
                }
              }.id("reply-projection")
            }
            if model.nextAfter != nil {
              Button("Load more") { Task { await model.loadHistory() } }
                .disabled(model.isLoading)
            }
          }
          .accessibilityIdentifier("conversation-transcript")
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .layoutPriority(1)
          .onChange(of: model.messages.count) { _, _ in scrollToLatest(proxy) }
          .onChange(of: model.replyText) { _, _ in scrollToLatest(proxy) }
          .onChange(of: model.replyIsWaiting) { _, _ in scrollToLatest(proxy) }
        }
        if let failure = model.replyProviderFailure {
          Text(
            failure.code == .memoryFailed || failure.code == .memoryPending
              ? "Message saved. Conversation context couldn’t be prepared."
              : "Message saved. Reply unavailable."
          )
          .foregroundStyle(.red).accessibilityIdentifier("reply-provider-status")
        }
        if model.canRetryReply {
          Button("Retry reply") { Task { await model.retryReply() } }
            .accessibilityIdentifier("retry-reply")
        }
        if model.state.currentFailure != nil && model.messages.isEmpty {
          Text("Reply status unavailable. Refresh to recover.")
            .foregroundStyle(.red).accessibilityIdentifier("current-turn-status")
        }
        if model.replyObservationFailure != nil {
          Text("Reply status unavailable. Refresh to recover.")
            .foregroundStyle(.red).accessibilityIdentifier("reply-observation-status")
        }
        if let failure = model.deliveryFailure {
          Text(description(failure)).foregroundStyle(.red)
            .accessibilityIdentifier("delivery-status")
        }
        if model.state.isWaitingForInterruptionRecovery {
          Text("Restoring interrupted replies before sending…")
            .accessibilityIdentifier("interrupted-receipt-waiting")
        }
        if model.state.interruptedReceiptFailure != nil {
          Text("Interrupted reply could not be restored. Refresh conversation to recover it.")
            .foregroundStyle(.red).accessibilityIdentifier("interrupted-receipt-status")
        }
        if model.historyFailure != nil {
          Text("History could not refresh. Retry without changing your draft.")
            .foregroundStyle(.red).accessibilityIdentifier("history-status")
        }
        if model.draftFailure != nil {
          Text("Draft could not be saved. Retry local saving before sending.")
            .foregroundStyle(.red).accessibilityIdentifier("draft-status")
        }
        if model.isSavingDraft { Text("Saving draft…") }
        if !model.draftStorageReady {
          Button("Retry saved draft") { Task { await model.reloadDraft() } }
        }
        HStack(alignment: .bottom) {
          TextField(
            "Message", text: Binding(get: { model.draft }, set: model.editDraft), axis: .vertical
          )
          .lineLimit(1...4)
          .textFieldStyle(.roundedBorder)
          .disabled(!model.canEditDraft)
          .accessibilityIdentifier("message-draft")
          Button(
            model.isSending
              ? "Sending…" : model.pendingDelivery == nil ? "Send" : "Retry same message"
          ) {
            Task { await model.send() }
          }
          .disabled(
            !model.canSendDraft
              || model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
          )
          .accessibilityIdentifier("send-message")
        }
      }
      .padding()
      .navigationTitle("Conversation")
      #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
      #endif
      .toolbar {
        Button("Refresh conversation") { Task { await model.refreshHistory() } }
          .disabled(model.isLoading)
      }
      .task {
        await model.start()
        await model.refreshHistory()
      }
      .onChange(of: scenePhase) { _, phase in
        if phase == .active { Task { await model.refreshHistory() } }
        if phase == .background { Task { await model.flushDraft() } }
      }
    }
    private func scrollToLatest(_ proxy: ScrollViewProxy) {
      if model.replyIsWaiting || !model.replyText.isEmpty {
        proxy.scrollTo("reply-projection", anchor: .bottom)
      } else if let last = model.messages.last {
        proxy.scrollTo(last.deliveryId, anchor: .bottom)
      }
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

  extension ConversationView where Details == EmptyView {
    public init(model: ConversationViewModel) { self.init(model: model) { EmptyView() } }
  }
#endif
