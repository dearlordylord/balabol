import Base

type Outcome is Data:
  Completed{}
  Interrupted{}

type Intent is Data:
  Intent{operation: Nat, payload: Nat, outcome: Outcome}

type TerminalState is Data:
  Open{attempt: Nat}
  Persisting{attempt: Nat, intent: Intent, invocation: Nat}
  Retryable{attempt: Nat, intent: Intent, invocation: Nat}
  Stored{attempt: Nat, intent: Intent}

type TerminalEvent is Data:
  Select{attempt: Nat, intent: Intent, invocation: Nat}
  StorageFailed{attempt: Nat, operation: Nat, invocation: Nat}
  RetryPersistence{attempt: Nat, operation: Nat, invocation: Nat}
  StoredAck{attempt: Nat, intent: Intent}

type Command is Data:
  NoCommand{}
  Persist{attempt: Nat, intent: Intent, invocation: Nat}

type Decision is Data:
  Decision{state: TerminalState, command: Command}

def initialize(attempt: Nat) -> TerminalState:
  Open{attempt}

def unchanged(state: TerminalState) -> Decision:
  Decision{state, NoCommand{}}

def outcome_matches(left: Outcome, right: Outcome) -> Bool:
  match left right:
    case Completed{} Completed{}:
      True{}
    case Interrupted{} Interrupted{}:
      True{}
    case _ _:
      False{}

def intent_matches(left: Intent, right: Intent) -> Bool:
  match left right:
    case Intent{leftOperation, leftPayload, leftOutcome} Intent{rightOperation, rightPayload, rightOutcome}:
      Bool.and(Nat.is_eq(leftOperation, rightOperation), Bool.and(Nat.is_eq(leftPayload, rightPayload), outcome_matches(leftOutcome, rightOutcome)))

def operation(intent: Intent) -> Nat:
  match intent:
    case Intent{operation, _, _}:
      operation

def select_decision(matches: Bool, state: TerminalState, +intent: Intent, +invocation: Nat) -> Decision:
  match matches state:
    case True{} Open{+attempt}:
      Decision{Persisting{attempt, intent, invocation}, Persist{attempt, intent, invocation}}
    case _ state:
      unchanged(state)

def select(state: TerminalState, requestedAttempt: Nat, intent: Intent, invocation: Nat) -> Decision:
  match state:
    case Open{+attempt}:
      select_decision(Nat.is_eq(attempt, requestedAttempt), Open{attempt}, intent, invocation)
    case state:
      unchanged(state)

def failure_decision(matches: Bool, state: TerminalState) -> Decision:
  match matches state:
    case True{} Persisting{attempt, intent, invocation}:
      Decision{Retryable{attempt, intent, invocation}, NoCommand{}}
    case _ state:
      unchanged(state)

def failure(state: TerminalState, requestedAttempt: Nat, requestedOperation: Nat, requestedInvocation: Nat) -> Decision:
  match state:
    case Persisting{+attempt, +intent, +invocation}:
      failure_decision(Bool.and(Nat.is_eq(attempt, requestedAttempt), Bool.and(Nat.is_eq(operation(intent), requestedOperation), Nat.is_eq(invocation, requestedInvocation))), Persisting{attempt, intent, invocation})
    case state:
      unchanged(state)

def retry_decision(matches: Bool, state: TerminalState, +invocation: Nat) -> Decision:
  match matches state:
    case True{} Retryable{+attempt, +intent, _}:
      Decision{Persisting{attempt, intent, invocation}, Persist{attempt, intent, invocation}}
    case _ state:
      unchanged(state)

def retry(state: TerminalState, requestedAttempt: Nat, requestedOperation: Nat, +requestedInvocation: Nat) -> Decision:
  match state:
    case Retryable{+attempt, +intent, +previousInvocation}:
      retry_decision(Bool.and(Nat.is_eq(attempt, requestedAttempt), Bool.and(Nat.is_eq(operation(intent), requestedOperation), Nat.is_gt(requestedInvocation, previousInvocation))), Retryable{attempt, intent, previousInvocation}, requestedInvocation)
    case state:
      unchanged(state)

def ack_decision(matches: Bool, state: TerminalState) -> Decision:
  match matches state:
    case True{} Persisting{attempt, intent, _}:
      Decision{Stored{attempt, intent}, NoCommand{}}
    case True{} Retryable{attempt, intent, _}:
      Decision{Stored{attempt, intent}, NoCommand{}}
    case _ state:
      unchanged(state)

def acknowledge(state: TerminalState, requestedAttempt: Nat, requestedIntent: Intent) -> Decision:
  match state:
    case Persisting{+attempt, +intent, invocation}:
      ack_decision(Bool.and(Nat.is_eq(attempt, requestedAttempt), intent_matches(intent, requestedIntent)), Persisting{attempt, intent, invocation})
    case Retryable{+attempt, +intent, invocation}:
      ack_decision(Bool.and(Nat.is_eq(attempt, requestedAttempt), intent_matches(intent, requestedIntent)), Retryable{attempt, intent, invocation})
    case state:
      unchanged(state)

def transition(state: TerminalState, event: TerminalEvent) -> Decision:
  match event:
    case Select{attempt, intent, invocation}:
      select(state, attempt, intent, invocation)
    case StorageFailed{attempt, operation, invocation}:
      failure(state, attempt, operation, invocation)
    case RetryPersistence{attempt, operation, invocation}:
      retry(state, attempt, operation, invocation)
    case StoredAck{attempt, intent}:
      acknowledge(state, attempt, intent)
