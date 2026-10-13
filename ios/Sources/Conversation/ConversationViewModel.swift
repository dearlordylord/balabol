import Foundation
import Observation

/// Projects the one server-owned conversation. A pending identity cannot be edited
/// until its outcome is resolved; successful HTTP alone does not confirm acceptance.
@MainActor @Observable
public final class ConversationViewModel {
  public private(set) var messages: [ConversationMessage] = []
  public private(set) var draft = ""
  public private(set) var pendingDelivery: PendingDelivery?
  public private(set) var isSending = false
  public private(set) var isLoading = false
  public private(set) var failure: ConversationFailure?
  public private(set) var nextAfter: Int?
  public private(set) var hasLoadedHistory = false
  public private(set) var draftStorageReady = false
  private let transport: any ConversationTransport
  private let draftStore: any DraftStore

  public init(transport: any ConversationTransport, draftStore: any DraftStore) {
    self.transport = transport
    self.draftStore = draftStore
    reloadDraft()
  }

  public func reloadDraft() {
    guard !isSending else { return }
    do {
      let saved = try draftStore.load()
      draft = saved.text
      pendingDelivery = saved.pending
      draftStorageReady = true
      failure = nil
    } catch {
      draftStorageReady = false
      failure = .draftStorageUnavailable
    }
  }

  public func editDraft(_ text: String) {
    guard draftStorageReady, !isSending, pendingDelivery == nil else { return }
    do {
      try draftStore.save(SavedDraft.editable(text: text))
      draft = text
      failure = nil
    } catch {
      draftStorageReady = false
      failure = .draftStorageUnavailable
    }
  }

  public func send() async {
    guard draftStorageReady else {
      failure = .draftStorageUnavailable
      return
    }
    guard !isSending else { return }
    guard !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      draft.utf16.count <= 100_000
    else {
      failure = .invalidInput
      return
    }
    let delivery = pendingDelivery ?? PendingDelivery(deliveryId: UUID(), text: draft)
    do {
      try draftStore.save(SavedDraft.awaitingReceipt(delivery))
    } catch {
      draftStorageReady = false
      failure = .draftStorageUnavailable
      return
    }
    pendingDelivery = delivery
    isSending = true
    failure = nil
    defer { isSending = false }
    do {
      let receipt = try await transport.send(delivery)
      guard receipt.deliveryId == delivery.deliveryId, receipt.text == delivery.text,
        receipt.isValid
      else {
        throw ConversationFailure.invalidResponse
      }
      try merge([receipt])
      try clearConfirmedDraft()
    } catch let error as ConversationFailure {
      if case .rejected(let code, _) = error, ["InvalidInput", "DeliveryConflict"].contains(code) {
        do {
          try draftStore.save(SavedDraft.editable(text: draft))
          pendingDelivery = nil
          failure = error
        } catch {
          draftStorageReady = false
          failure = .draftStorageUnavailable
        }
      } else {
        failure = error
      }
    } catch { failure = .unavailable }
  }

  public func loadHistory() async {
    guard !isLoading, !hasLoadedHistory || nextAfter != nil else { return }
    isLoading = true
    failure = nil
    defer { isLoading = false }
    do {
      let page = try await transport.history(after: hasLoadedHistory ? nextAfter : nil)
      guard page.messages.count <= HistoryPage.maximumMessages,
        page.messages.allSatisfy(\.isValid),
        zip(page.messages, page.messages.dropFirst()).allSatisfy({ $0.position < $1.position }),
        page.messages.first.map({ $0.position > (nextAfter ?? -1) }) ?? true,
        page.nextAfter == nil || page.nextAfter == page.messages.last?.position
      else {
        throw ConversationFailure.invalidResponse
      }
      if let pendingDelivery,
        let accepted = page.messages.first(where: { $0.deliveryId == pendingDelivery.deliveryId })
      {
        guard accepted.text == pendingDelivery.text else {
          throw ConversationFailure.invalidResponse
        }
        try merge(page.messages)
        try clearConfirmedDraft()
      } else {
        try merge(page.messages)
      }
      nextAfter = page.nextAfter
      hasLoadedHistory = true
    } catch let error as ConversationFailure { failure = error } catch { failure = .unavailable }
  }

  private func clearConfirmedDraft() throws {
    do { try draftStore.save(SavedDraft.editable(text: "")) } catch {
      draftStorageReady = false
      throw ConversationFailure.draftStorageUnavailable
    }
    draft = ""
    pendingDelivery = nil
  }

  private func merge(_ incoming: [ConversationMessage]) throws {
    var merged = messages
    for message in incoming {
      if let existing = merged.first(where: { $0.deliveryId == message.deliveryId }) {
        guard existing == message else { throw ConversationFailure.invalidResponse }
      } else {
        guard
          !merged.contains(where: {
            $0.position == message.position || $0.recordId == message.recordId
          })
        else {
          throw ConversationFailure.invalidResponse
        }
        merged.append(message)
      }
    }
    messages = merged.sorted { $0.position < $1.position }
  }
}
