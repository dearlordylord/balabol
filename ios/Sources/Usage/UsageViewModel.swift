import Foundation
import Observation

public struct UsageState: Equatable, Sendable {
  public let snapshot: UsageSnapshot?
  public let loading: Bool
  public let failure: UsageFailure?
  let revision: Int
  public init() { self.init(snapshot: nil, loading: false, failure: nil, revision: 0) }
  init(snapshot: UsageSnapshot?, loading: Bool, failure: UsageFailure?, revision: Int) {
    self.snapshot = snapshot; self.loading = loading; self.failure = failure; self.revision = revision
  }
}
internal enum UsageEvent {
  case refresh
  case loaded(Int, Result<UsageSnapshot, UsageFailure>)
  case cancelled(Int)
}
/// One immutable projection; late refreshes cannot overwrite newer observations.
internal func transitionUsage(_ state: UsageState, _ event: UsageEvent) -> UsageState {
  switch event {
  case .refresh:
    return UsageState(snapshot: state.snapshot, loading: true, failure: nil, revision: state.revision + 1)
  case .loaded(let revision, let result):
    guard revision == state.revision else { return state }
    switch result {
    case .success(let value):
      let previous = state.snapshot?.speech
      let speech: SpeechUsageSnapshot
      if value.speech.status != "available", let previous, previous.scope == value.speech.scope,
        !previous.models.isEmpty {
        speech = SpeechUsageSnapshot(scope: previous.scope, status: value.speech.status,
          startTime: previous.startTime, endTime: previous.endTime, fetchedAt: previous.fetchedAt, models: previous.models)
      } else { speech = value.speech }
      return UsageState(snapshot: UsageSnapshot(ledger: value.ledger, speech: speech), loading: false, failure: nil, revision: revision)
    case .failure(let failure):
      return UsageState(snapshot: state.snapshot, loading: false, failure: failure, revision: revision)
    }
  case .cancelled(let revision):
    return revision == state.revision ? UsageState(snapshot: state.snapshot, loading: false,
      failure: state.failure, revision: revision) : state
  }
}
@MainActor @Observable public final class UsageViewModel {
  public private(set) var state = UsageState()
  @ObservationIgnored private let client: any UsageClient
  public init(client: any UsageClient) { self.client = client }
  public func refresh() async {
    state = transitionUsage(state, .refresh)
    let revision = state.revision
    do {
      let value = try await client.load()
      try Task.checkCancellation()
      state = transitionUsage(state, .loaded(revision, value.isValid ? .success(value) : .failure(.invalidResponse)))
    } catch is CancellationError {
      state = transitionUsage(state, .cancelled(revision))
    } catch {
      state = transitionUsage(state, .loaded(revision, .failure((error as? UsageFailure) ?? .unavailable)))
    }
  }
}
