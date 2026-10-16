import Base
import ./core.bend as Core
import ./Spec.bend as Spec

# The first matching selection dispatches its exact intent; foreign/repeated selections do nothing.
law selection_characterized:
  for +state: Core.TerminalState
  for +attempt: Nat
  for +intent: Core.Intent
  for +invocation: Nat
  {Core.transition(state, Core.Select{attempt, intent, invocation}) == Spec.selection(state, attempt, intent, invocation) : Core.Decision}

# Once selected, no later event can replace or erase the attempt, payload, operation or outcome.
law selected_intent_conserved:
  for phase: Spec.SelectedPhase
  for +attempt: Nat
  for +intent: Core.Intent
  for event: Core.TerminalEvent
  {Spec.snapshot(Spec.state(Core.transition(Spec.materialize(phase, attempt, intent), event))) == Spec.Selected{attempt, intent} : Spec.SelectionView}

# Exact durable evidence settles writing or retryable state; wrong evidence is inert.
law acknowledgement_characterized:
  for +state: Core.TerminalState
  for +attempt: Nat
  for +intent: Core.Intent
  {Core.transition(state, Core.StoredAck{attempt, intent}) == Spec.acknowledgement(state, attempt, intent) : Core.Decision}

# Only an explicit, correctly targeted, strictly fresher retry dispatches the retained obligation.
law retry_characterized:
  for +state: Core.TerminalState
  for +attempt: Nat
  for +operation: Nat
  for +invocation: Nat
  {Core.transition(state, Core.RetryPersistence{attempt, operation, invocation}) == Spec.retry(state, attempt, operation, invocation) : Core.Decision}

# A stored terminal result is absorbing and cannot dispatch another write.
law stored_absorbing:
  for +attempt: Nat
  for +intent: Core.Intent
  for event: Core.TerminalEvent
  {Core.transition(Core.Stored{attempt, intent}, event) == Core.Decision{Core.Stored{attempt, intent}, Core.NoCommand{}} : Core.Decision}

# Only failure from the exact current invocation makes the same intent retryable.
law failure_characterized:
  for +state: Core.TerminalState
  for +attempt: Nat
  for +operation: Nat
  for +invocation: Nat
  {Core.transition(state, Core.StorageFailed{attempt, operation, invocation}) == Spec.failure(state, attempt, operation, invocation) : Core.Decision}

# Every new attempt starts open so its first valid selection can make progress.
law initialization_characterized:
  for +attempt: Nat
  {Core.initialize(attempt) == Core.Open{attempt} : Core.TerminalState}
