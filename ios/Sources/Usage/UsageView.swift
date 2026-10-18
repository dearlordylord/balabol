#if canImport(SwiftUI)
import SwiftUI

@MainActor public struct UsageView: View {
  @Bindable private var model: UsageViewModel
  @Environment(\.dismiss) private var dismiss
  public init(model: UsageViewModel) { self.model = model }
  public var body: some View {
    NavigationStack {
      List {
        if let failure = model.state.failure {
          Section { Text(failure.message).foregroundStyle(.secondary) }
        }
        if let snapshot = model.state.snapshot {
          Section {
            tokenCategory("Chat", category: "chat", snapshot: snapshot)
            tokenCategory("Memory summaries", category: "memory", snapshot: snapshot)
          } header: { Text("Subscription usage") } footer: {
            VStack(alignment: .leading) {
              if let since = snapshot.ledger.since {
                Text("Recorded since \(Date(timeIntervalSince1970: since / 1000).formatted(date: .abbreviated, time: .shortened)).")
              } else { Text("Token accounting starts with your next model request.") }
              Text("Cached input is included in input tokens. These are subscription counters, not additional dollar charges.")
              if snapshot.ledger.degraded { Text("Some usage could not be saved. Totals may be incomplete.") }
            }
          }
          Section {
            speechCategory("Speech recognition", prefix: "stt-", snapshot: snapshot.speech)
            speechCategory("Speech synthesis", prefix: "tts-", snapshot: snapshot.speech)
          } header: { Text("Soniox project · USD") } footer: {
            VStack(alignment: .leading) {
              Text("Last 30 days, by UTC day. Includes all API traffic in the configured Soniox project.")
              if snapshot.speech.status != "available", !snapshot.speech.models.isEmpty {
                Text("Showing the last successful report.")
              }
              Text("Checked \(Date(timeIntervalSince1970: snapshot.speech.fetchedAt / 1000).formatted(date: .abbreviated, time: .shortened)).")
            }
          }
          if !snapshot.ledger.recent.isEmpty {
            Section("Recent model requests") {
              ForEach(snapshot.ledger.recent) { attempt in
                VStack(alignment: .leading) {
                  Text(attempt.category == "memory" ? "Memory summary" : "Chat")
                  Text("\(attempt.model) · \(attempt.outcome.capitalized)").font(.caption).foregroundStyle(.secondary)
                  Text(Date(timeIntervalSince1970: attempt.startedAt / 1000), style: .time).font(.caption).foregroundStyle(.secondary)
                }
              }
            }
          }
        } else if model.state.loading {
          ProgressView("Loading usage…")
        }
      }
      .refreshable { await model.refresh() }
      .navigationTitle("Usage")
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
      .task { await model.refresh() }
    }
  }
  @ViewBuilder private func tokenCategory(_ title: String, category: String, snapshot: UsageSnapshot) -> some View {
    let totals = snapshot.ledger.totals.filter { $0.category == category }
    DisclosureGroup {
      if totals.isEmpty { Text("Not yet recorded").foregroundStyle(.secondary) }
      ForEach(totals, id: \.model) { total in
        Text(total.model).font(.caption).foregroundStyle(.secondary)
        metric("Input tokens", total.input)
        metric("Cached input tokens", total.cachedInput)
        metric("Output tokens", total.output)
        metric("Reasoning tokens", total.reasoningOutput)
        LabeledContent("Requests", value: total.attempts.formatted())
        if total.unreported > 0 {
          Text("Partial · \(total.unreported) requests have missing usage.").font(.caption).foregroundStyle(.secondary)
        }
      }
    } label: {
      VStack(alignment: .leading) {
        Text(title)
        if let total = totals.first {
          Text("\(total.input.map { $0.formatted() } ?? "Unavailable") input · \(total.output.map { $0.formatted() } ?? "Unavailable") output")
            .font(.caption).foregroundStyle(.secondary)
        } else { Text("Not yet recorded").font(.caption).foregroundStyle(.secondary) }
      }
    }
  }
  @ViewBuilder private func speechCategory(_ title: String, prefix: String, snapshot: SpeechUsageSnapshot) -> some View {
    let totals = snapshot.models.filter { $0.model.hasPrefix(prefix) }
    DisclosureGroup {
      if snapshot.status != "available" {
        Text(speechStatus(snapshot.status)).foregroundStyle(.secondary)
      } else if totals.isEmpty { Text("No reported usage in this period").foregroundStyle(.secondary) }
      ForEach(totals, id: \.model) { total in
        Text(total.model).font(.caption).foregroundStyle(.secondary)
        LabeledContent("API cost", value: "$\(total.costUSD)")
        metric("Requests", total.requests)
        metric("Input text tokens", total.inputTextTokens)
        metric("Input audio tokens", total.inputAudioTokens)
        metric("Output text tokens", total.outputTextTokens)
        metric("Output audio tokens", total.outputAudioTokens)
        LabeledContent("Input audio", value: String(format: "%.1f min", Double(total.inputAudioMillis) / 60000))
        LabeledContent("Generated audio", value: String(format: "%.1f min", Double(total.outputAudioMillis) / 60000))
      }
    } label: {
      VStack(alignment: .leading) {
        Text(title)
        if totals.count == 1, let total = totals.first {
          Text("$\(total.costUSD)").font(.caption).foregroundStyle(.secondary)
        } else if snapshot.status != "available" {
          Text("Unavailable").font(.caption).foregroundStyle(.secondary)
        } else { Text("\(totals.count) models reported").font(.caption).foregroundStyle(.secondary) }
      }
    }
  }
  private func metric(_ title: String, _ value: Int?) -> some View {
    LabeledContent(title, value: value.map { $0.formatted() } ?? "Unavailable")
  }
  private func speechStatus(_ value: String) -> String {
    switch value {
    case "notConfigured": "Soniox is not configured."
    case "authentication": "Soniox authentication failed."
    case "permission": "The Soniox key does not allow reading usage."
    default: "Soniox usage is unavailable. Pull to refresh."
    }
  }
}
#endif
