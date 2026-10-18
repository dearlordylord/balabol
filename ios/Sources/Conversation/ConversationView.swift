#if canImport(SwiftUI)
  import SwiftUI

  public struct ConversationView<Controls: View, Details: View>: View {
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOverEnabled
    #if os(iOS)
      @Environment(\.verticalSizeClass) private var verticalSizeClass
    #endif
    @FocusState private var draftFocused: Bool
    @State private var followsLatest = true
    @State private var readingAnchor: ConversationReadingAnchor?
    @State private var transcriptFrame: CGRect = .zero
    @State private var olderAnchor: ConversationReadingAnchor?
    @Bindable private var model: ConversationViewModel
    private let controls: Controls
    private let details: Details

    /// Composition supplies feature-owned controls and details; only their placement belongs here.
    public init(
      model: ConversationViewModel,
      @ViewBuilder controls: () -> Controls,
      @ViewBuilder details: () -> Details
    ) {
      self.model = model
      self.controls = controls()
      self.details = details()
    }

    private var scrollsControls: Bool {
      #if os(iOS)
        typeSize.isAccessibilitySize || verticalSizeClass == .compact || draftFocused
      #else
        typeSize.isAccessibilitySize || draftFocused
      #endif
    }

    public var body: some View {
      VStack(spacing: 0) {
        if !scrollsControls { controls.padding(.horizontal, 16) }
        ScrollViewReader { proxy in
          ScrollView {
            // Loaded history has real row heights before scrolling, including live-to-saved replacement.
            VStack(alignment: .leading, spacing: 16) {
              if scrollsControls {
                controls
              }
              if model.messages.isEmpty && !model.replyIsWaiting && model.replyText.isEmpty {
                introduction
              }
              if model.nextBefore != nil {
                Button {
                  followsLatest = false
                  olderAnchor = readingAnchor
                  Task {
                    await model.loadOlderHistory()
                    if model.historyFailure != nil { olderAnchor = nil }
                  }
                } label: {
                  Label("Load older messages", systemImage: "arrow.up.circle")
                    .frame(minHeight: 44)
                }
                .disabled(model.isLoading)
                .accessibilityIdentifier("load-older-messages")

              }
              ForEach(model.messages, id: \.deliveryId.uuidString) { message in
                messageRow(message)
                  .background {
                    GeometryReader { geometry in
                      Color.clear.preference(
                        key: ConversationRowFrames.self,
                        value: [message.deliveryId.uuidString: geometry.frame(in: .global)])
                    }
                  }
                  .id(message.deliveryId.uuidString)
              }
              details
              if model.replyIsWaiting || !model.replyText.isEmpty {
                replyProjection.id("reply-projection")
                  .background {
                    GeometryReader { geometry in
                      Color.clear.preference(
                        key: ConversationRowFrames.self,
                        value: ["reply-projection": geometry.frame(in: .global)])
                    }
                  }
              }
              replyNotices
              historyNotices
              draftNotices
              DisclosureGroup("About this prototype") {
                Text(
                  "Providers are configured on your Mac. Scripted replies and speech may be enabled."
                )
                .font(.footnote).foregroundStyle(.primary.opacity(0.75))
                .accessibilityIdentifier("demo-provider")
              }
              .font(.footnote).foregroundStyle(.primary.opacity(0.75))
              Color.clear.frame(height: 1).id("latest-message").accessibilityHidden(true)
                .background {
                  GeometryReader { geometry in
                    Color.clear.preference(
                      key: ConversationRowFrames.self,
                      value: ["latest-message": geometry.frame(in: .global)])
                  }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
          }
          .background {
            GeometryReader { geometry in
              Color.clear
                .onAppear { transcriptFrame = geometry.frame(in: .global) }
                .onChange(of: geometry.frame(in: .global)) { _, frame in
                  transcriptFrame = frame
                  olderAnchor = nil
                }
            }
          }
          .onPreferenceChange(ConversationRowFrames.self) { frames in
            recordViewport(frames)
            if !followsLatest && olderAnchor == nil {
              let anchor = ConversationReadingAnchor(
                frames: frames.filter {
                  $0.key != "latest-message" && $0.key != "reply-projection"
                }, viewport: transcriptFrame)
              if readingAnchor != anchor { readingAnchor = anchor }
              if let bottom = frames["latest-message"],
                bottom.maxY <= transcriptFrame.maxY + 24,
                bottom.maxY >= transcriptFrame.minY
              { followsLatest = true }
            }
            // Geometry arrives after layout; model notifications can still carry the old height.
            if followsLatest, olderAnchor == nil, transcriptFrame.height > 0,
              let bottom = frames["latest-message"], bottom.maxY > transcriptFrame.maxY + 1
            { scrollToLatest(proxy) }
            if var anchor = olderAnchor, anchor.isRestoring,
              let frame = frames[anchor.message], frame.intersects(transcriptFrame)
            {
              if anchor.refine(using: frame) {
                olderAnchor = anchor
                proxy.scrollTo(anchor.message, anchor: anchor.alignment)
              } else {
                olderAnchor = nil
              }
            }
          }
          .onChange(of: model.messages.first?.deliveryId) { _, _ in
            if var anchor = olderAnchor {
              anchor.isRestoring = true
              olderAnchor = anchor
              proxy.scrollTo(anchor.message, anchor: anchor.alignment)
            }
          }
          .accessibilityIdentifier("conversation-transcript")
          .scrollDismissesKeyboard(.interactively)
          .simultaneousGesture(
            DragGesture(minimumDistance: 12).onChanged { value in
              if abs(value.translation.height) > 12 { olderAnchor = nil }
              if value.translation.height > 12 { followsLatest = false }
            }
          )
          .overlay(alignment: .bottomTrailing) {
            if !followsLatest
              && (!model.messages.isEmpty || model.replyIsWaiting || !model.replyText.isEmpty)
            {
              Button {
                olderAnchor = nil
                followsLatest = true
                proxy.scrollTo("latest-message", anchor: .bottom)
              } label: {
                Label("Latest message", systemImage: "arrow.down")
                  .labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44)
              }
              .buttonStyle(.borderedProminent)
              .padding(8)
              .accessibilityIdentifier("latest-message")
            }
          }
          .onChange(of: model.isSending) { _, sending in
            if sending { olderAnchor = nil }
          }
          .onChange(of: transcriptFrame) { _, _ in scrollToLatest(proxy) }
        }
      }
      .safeAreaInset(edge: .bottom, spacing: 0) { composer }
      .navigationTitle("Balabol")
      #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
      #endif
      .toolbar {
        ToolbarItem {
          Button {
            Task { await model.refreshHistory() }
          } label: {
            Label("Refresh conversation", systemImage: "arrow.clockwise")
              .frame(minWidth: 44, minHeight: 44)
          }
          .disabled(model.isLoading)
        }
        #if os(iOS)
          ToolbarItemGroup(placement: .keyboard) {
            Spacer()
            Button("Done") { draftFocused = false }
          }
        #endif
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

    @ViewBuilder private var introduction: some View {
      if model.isLoading || !model.hasLoadedHistory && model.historyFailure == nil {
        HStack(spacing: 12) {
          ProgressView()
          Text("Loading conversation…").foregroundStyle(.primary.opacity(0.75))
        }.padding(.vertical, 24)
      } else if model.historyFailure == nil {
        VStack(alignment: .leading, spacing: 12) {
          Image(systemName: "bubble.left.and.bubble.right")
            .font(.largeTitle).foregroundStyle(.tint).accessibilityHidden(true)
          Text("One conversation, always here").font(.title2).fontWeight(.semibold)
          Text("Start voice above, or write a message below.")
            .foregroundStyle(.primary.opacity(0.75))
        }
        .padding(.vertical, 24)
        .accessibilityIdentifier("conversation-empty")
      }
    }

    private func messageRow(_ message: ConversationMessage) -> some View {
      HStack {
        if message.role == .user { Spacer(minLength: 24) }
        VStack(alignment: .leading, spacing: 8) {
          Text(message.role == .user ? "You" : "Assistant")
            .font(.footnote).fontWeight(.semibold).foregroundStyle(.primary.opacity(0.75))
          if !message.languageSpans.isEmpty {
            Text(LanguageSpan.displayNames(message.languageSpans)).font(.caption)
              .foregroundStyle(.primary.opacity(0.75))
              .accessibilityIdentifier("message-languages-\(message.position)")
          }
          if let failure = message.failure {
            Text("Reply failed: \(failure.message)").font(.caption)
              .accessibilityIdentifier("failed-message-\(message.position)")
          } else if message.outcome == .interrupted {
            HStack(spacing: 6) {
              Image(systemName: "pause.circle").accessibilityHidden(true)
              Text("Interrupted").accessibilityIdentifier("interrupted-message-\(message.position)")
            }
            .font(.caption).foregroundStyle(.primary.opacity(0.75))
            Text("Generated text may include audio you did not hear.")
              .font(.caption).foregroundStyle(.primary.opacity(0.75))
          }
          Text(
            message.text.isEmpty && message.outcome == .interrupted
              ? "Interrupted before a reply appeared" : message.text
          )
          .textSelection(.enabled)
          .accessibilityIdentifier(
            message.role == .assistant
              ? "assistant-message-\(message.position)" : "message-\(message.position)")
        }
        .frame(maxWidth: 680, alignment: .leading)
        .padding(message.role == .user ? 14 : 0)
        .background {
          if message.role == .user {
            RoundedRectangle(cornerRadius: 18).fill(.quaternary)
          }
        }
        .accessibilityElement(children: .contain)
        if message.role == .assistant { Spacer(minLength: 0) }
      }
      .frame(maxWidth: 720)
      .frame(maxWidth: .infinity)
      .padding(.vertical, 6)
    }

    private var replyProjection: some View {
      VStack(alignment: .leading, spacing: 8) {
        Text("Assistant").font(.footnote).fontWeight(.semibold).foregroundStyle(
          .primary.opacity(0.75))
        if model.replyIsWaiting {
          HStack(spacing: 10) {
            ProgressView()
            Text(model.state.replyRetryProgress.map { "Trying again… Retry \($0.attempt - 1) of \($0.maximumAttempts - 1)" }
              ?? (model.state.isRetryingReply ? "Retrying reply…" : "Preparing your reply…"))
              .foregroundStyle(.primary.opacity(0.75)).accessibilityIdentifier("reply-waiting")
          }
        }
        if !model.state.replyLanguageSpans.isEmpty {
          Text(LanguageSpan.displayNames(model.state.replyLanguageSpans)).font(.caption)
            .foregroundStyle(.primary.opacity(0.75)).accessibilityIdentifier("reply-languages")
        }
        if !model.replyText.isEmpty {
          Text(model.replyText).textSelection(.enabled).accessibilityIdentifier("reply-progress")
        }
      }
      .frame(maxWidth: 680, alignment: .leading)
      .padding(.vertical, 6)
    }

    @ViewBuilder private var replyNotices: some View {
      if let failure = model.replyProviderFailure {
        notice(
          "Reply failed: \(failure.message)", id: "reply-provider-status")
      }
      if model.canRetryReply {
        Button("Retry reply") { Task { await model.retryReply() } }
          .frame(minHeight: 44).buttonStyle(.bordered)
          .accessibilityIdentifier("retry-reply")
      }
      if model.state.currentFailure != nil && model.messages.isEmpty {
        notice("Reply status unavailable. Refresh to recover.", id: "current-turn-status")
      }
      if model.replyObservationFailure != nil {
        notice("Reply status unavailable. Refresh to recover.", id: "reply-observation-status")
      }
      if model.state.interruptedReceiptFailure != nil {
        notice(
          "Interrupted reply could not be restored. Refresh to recover it.",
          id: "interrupted-receipt-status")
      }
    }

    @ViewBuilder private var historyNotices: some View {
      if model.historyFailure != nil {
        notice("History could not refresh. Your draft is kept.", id: "history-status")
        Button("Refresh conversation") { Task { await model.refreshHistory() } }
          .frame(minHeight: 44).buttonStyle(.bordered)
      }
    }

    @ViewBuilder private var draftNotices: some View {
      if let failure = model.deliveryFailure {
        notice(description(failure), id: "delivery-status")
      }
      if model.state.isWaitingForInterruptionRecovery {
        Label("Restoring interrupted replies before sending…", systemImage: "clock")
          .font(.footnote).accessibilityIdentifier("interrupted-receipt-waiting")
      }
      if model.draftFailure != nil {
        notice("Draft could not be saved. Retry local saving before sending.", id: "draft-status")
      }
    }

    private var composer: some View {
      VStack(alignment: .leading, spacing: 10) {
        Divider()
        VStack(alignment: .leading, spacing: 10) {
          if !model.draftStorageReady {
            Button("Retry saved draft") { Task { await model.reloadDraft() } }.frame(minHeight: 44)
          }
          if typeSize.isAccessibilitySize && model.pendingDelivery != nil {
            VStack(alignment: .trailing, spacing: 8) {
              draftField
              sendButton
            }
          } else {
            HStack(alignment: .bottom, spacing: 12) {
              draftField
              sendButton
            }
          }
        }
        .padding(.horizontal, 16).padding(.bottom, 12)
        .frame(maxWidth: 720)
        .frame(maxWidth: .infinity)
      }
      .background(.regularMaterial)
    }

    private var draftField: some View {
      TextField(
        "Message", text: Binding(get: { model.draft }, set: model.editDraft),
        prompt: Text("Message").foregroundColor(.primary.opacity(0.75)), axis: .vertical
      )
      .lineLimit(1...(typeSize.isAccessibilitySize ? (draftFocused ? 1 : 2) : 5))
      .padding(.horizontal, 12).padding(.vertical, 10)
      .frame(minHeight: 44)
      .background(.background, in: RoundedRectangle(cornerRadius: 16))
      .overlay(RoundedRectangle(cornerRadius: 16).stroke(.secondary.opacity(0.3), lineWidth: 0.5))
      .focused($draftFocused)
      .disabled(!model.canEditDraft)
      .accessibilityLabel("Message")
      .accessibilityIdentifier("message-draft")
    }

    private var sendButton: some View {
      Button {
        followsLatest = true
        Task { await model.send() }
      } label: {
        if typeSize.isAccessibilitySize && model.pendingDelivery == nil {
          Image(systemName: "arrow.up")
            .font(.system(size: 20, weight: .semibold))
            .frame(minWidth: 24, minHeight: 32)
        } else {
          Text(
            model.isSending
              ? "Sending…" : model.pendingDelivery == nil ? "Send" : "Retry same message"
          )
          .fontWeight(.semibold).frame(minWidth: 44, minHeight: 32)
          .fixedSize(horizontal: false, vertical: true)
        }
      }
      .buttonStyle(.borderedProminent).controlSize(.large)
      .disabled(
        !model.canSendDraft || model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      )
      .accessibilityLabel(
        model.isSending ? "Sending" : model.pendingDelivery == nil ? "Send" : "Retry same message"
      )
      .accessibilityIdentifier("send-message")
    }

    private func notice(_ text: String, id: String) -> some View {
      Label {
        Text(text).accessibilityIdentifier(id)
      } icon: {
        Image(systemName: "exclamationmark.circle").foregroundStyle(.orange).accessibilityHidden(
          true)
      }
      .font(.footnote)
      .padding(12).frame(maxWidth: 680, alignment: .leading)
      .background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
    }

    private func recordViewport(_ rowFrames: [String: CGRect]) {
      guard model.diagnosticsEnabled else { return }
      let rows = rowFrames.filter { $0.key != "latest-message" }
      let snapshot = ConversationViewportDiagnostics.Snapshot(
        uptime: ProcessInfo.processInfo.systemUptime, messages: model.messages.count,
        replyLength: model.replyText.utf16.count,
        viewportHeight: transcriptFrame.height, viewportWidth: transcriptFrame.width,
        measuredRows: rows.count,
        visibleRows: rows.values.filter { $0.intersects(transcriptFrame) }.count,
        bottomOffset: rowFrames["latest-message"].map { $0.maxY - transcriptFrame.maxY })
      ConversationViewportDiagnostics.record(snapshot)
    }

    private func scrollToLatest(_ proxy: ScrollViewProxy) {
      guard followsLatest && !voiceOverEnabled else { return }
      proxy.scrollTo("latest-message", anchor: .bottom)
    }

    private func description(_ failure: ConversationFailure) -> String {
      switch failure {
      case .invalidInput: "Enter a nonempty message up to 100,000 characters."
      case .invalidResponse, .unavailable:
        "Delivery is unconfirmed. Your message is kept; retry the same message."
      case .rejected:
        "Message wasn’t accepted. Your draft is kept. Review it and try again."
      case .draftStorageUnavailable: "Saved draft is unavailable. Reload it before sending."
      }
    }
  }

  extension ConversationView where Controls == EmptyView {
    public init(model: ConversationViewModel, @ViewBuilder details: () -> Details) {
      self.init(model: model, controls: { EmptyView() }, details: details)
    }
  }

  extension ConversationView where Controls == EmptyView, Details == EmptyView {
    public init(model: ConversationViewModel) {
      self.init(model: model, controls: { EmptyView() }, details: { EmptyView() })
    }
  }
#endif
