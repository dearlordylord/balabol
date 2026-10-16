import Base
import ./core.bend as Core

# Independent specification functions inspect data, never production decisions.
type SelectionView is Data:
  NoSelection{attempt: Nat}
  Selected{attempt: Nat, intent: Core.Intent}

type SelectedPhase is Data:
  Writing{invocation: Nat}
  Recovering{invocation: Nat}
  Settled{}

def materialize(phase: SelectedPhase, attempt: Nat, intent: Core.Intent) -> Core.TerminalState:
  match phase:
    case Writing{invocation}:
      Core.Persisting{attempt, intent, invocation}
    case Recovering{invocation}:
      Core.Retryable{attempt, intent, invocation}
    case Settled{}:
      Core.Stored{attempt, intent}

def snapshot(state: Core.TerminalState) -> SelectionView:
  match state:
    case Core.Open{attempt}:
      NoSelection{attempt}
    case Core.Persisting{attempt, intent, _}:
      Selected{attempt, intent}
    case Core.Retryable{attempt, intent, _}:
      Selected{attempt, intent}
    case Core.Stored{attempt, intent}:
      Selected{attempt, intent}

def state(decision: Core.Decision) -> Core.TerminalState:
  match decision:
    case Core.Decision{state, _}:
      state

def unchanged(state: Core.TerminalState) -> Core.Decision:
  Core.Decision{state, Core.NoCommand{}}

def operation(intent: Core.Intent) -> Nat:
  match intent:
    case Core.Intent{operation, _, _}:
      operation

def outcome_equal(left: Core.Outcome, right: Core.Outcome) -> Bool:
  match left right:
    case Core.Completed{} Core.Completed{}:
      True{}
    case Core.Interrupted{} Core.Interrupted{}:
      True{}
    case _ _:
      False{}

def intent_equal(left: Core.Intent, right: Core.Intent) -> Bool:
  match left right:
    case Core.Intent{leftOperation, leftPayload, leftOutcome} Core.Intent{rightOperation, rightPayload, rightOutcome}:
      Bool.and(Nat.is_eq(leftOperation, rightOperation), Bool.and(Nat.is_eq(leftPayload, rightPayload), outcome_equal(leftOutcome, rightOutcome)))

def selection_if(matches: Bool, +attempt: Nat, +intent: Core.Intent, +invocation: Nat) -> Core.Decision:
  match matches:
    case True{}:
      Core.Decision{Core.Persisting{attempt, intent, invocation}, Core.Persist{attempt, intent, invocation}}
    case False{}:
      unchanged(Core.Open{attempt})

def selection(state: Core.TerminalState, requestedAttempt: Nat, intent: Core.Intent, invocation: Nat) -> Core.Decision:
  match state:
    case Core.Open{+attempt}:
      selection_if(Nat.is_eq(attempt, requestedAttempt), attempt, intent, invocation)
    case state:
      unchanged(state)

def failure_if(matches: Bool, attempt: Nat, intent: Core.Intent, invocation: Nat) -> Core.Decision:
  match matches:
    case True{}:
      Core.Decision{Core.Retryable{attempt, intent, invocation}, Core.NoCommand{}}
    case False{}:
      unchanged(Core.Persisting{attempt, intent, invocation})

def failure(state: Core.TerminalState, requestedAttempt: Nat, requestedOperation: Nat, requestedInvocation: Nat) -> Core.Decision:
  match state:
    case Core.Persisting{+attempt, +intent, +invocation}:
      failure_if(Bool.and(Nat.is_eq(attempt, requestedAttempt), Bool.and(Nat.is_eq(operation(intent), requestedOperation), Nat.is_eq(invocation, requestedInvocation))), attempt, intent, invocation)
    case state:
      unchanged(state)

def retry_if(matches: Bool, +attempt: Nat, +intent: Core.Intent, previousInvocation: Nat, +nextInvocation: Nat) -> Core.Decision:
  match matches:
    case True{}:
      Core.Decision{Core.Persisting{attempt, intent, nextInvocation}, Core.Persist{attempt, intent, nextInvocation}}
    case False{}:
      unchanged(Core.Retryable{attempt, intent, previousInvocation})

def retry(state: Core.TerminalState, requestedAttempt: Nat, requestedOperation: Nat, +requestedInvocation: Nat) -> Core.Decision:
  match state:
    case Core.Retryable{+attempt, +intent, +previousInvocation}:
      retry_if(Bool.and(Nat.is_eq(attempt, requestedAttempt), Bool.and(Nat.is_eq(operation(intent), requestedOperation), Nat.is_gt(requestedInvocation, previousInvocation))), attempt, intent, previousInvocation, requestedInvocation)
    case state:
      unchanged(state)

def acknowledgement_if(matches: Bool, state: Core.TerminalState, attempt: Nat, intent: Core.Intent) -> Core.Decision:
  match matches:
    case True{}:
      Core.Decision{Core.Stored{attempt, intent}, Core.NoCommand{}}
    case False{}:
      unchanged(state)

def acknowledgement(state: Core.TerminalState, requestedAttempt: Nat, requestedIntent: Core.Intent) -> Core.Decision:
  match state:
    case Core.Persisting{+attempt, +intent, invocation}:
      acknowledgement_if(Bool.and(Nat.is_eq(attempt, requestedAttempt), intent_equal(intent, requestedIntent)), Core.Persisting{attempt, intent, invocation}, attempt, intent)
    case Core.Retryable{+attempt, +intent, invocation}:
      acknowledgement_if(Bool.and(Nat.is_eq(attempt, requestedAttempt), intent_equal(intent, requestedIntent)), Core.Retryable{attempt, intent, invocation}, attempt, intent)
    case state:
      unchanged(state)
