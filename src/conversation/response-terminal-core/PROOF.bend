import Base
import ./core.bend as Core
import ./Spec.bend as Spec
import ./LAWS.bend as Laws

# ---- selection_characterized ----
def selection_agrees(matches: Bool, +attempt: Nat, +intent: Core.Intent, +invocation: Nat) -> {Core.select_decision(matches, Core.Open{attempt}, intent, invocation) == Spec.selection_if(matches, attempt, intent, invocation) : Core.Decision}:
  match matches:
    case True{}:
      {==}
    case False{}:
      {==}

def Laws.selection_characterized(state, attempt, intent, invocation):
  match state:
    case Core.Open{+currentAttempt}:
      selection_agrees(Nat.is_eq(currentAttempt, attempt), currentAttempt, intent, invocation)
    case Core.Persisting{_, _, _}:
      {==}
    case Core.Retryable{_, _, _}:
      {==}
    case Core.Stored{_, _}:
      {==}

# ---- selected_intent_conserved ----
def failure_conserves(matches: Bool, +attempt: Nat, +intent: Core.Intent, invocation: Nat) -> {Spec.snapshot(Spec.state(Core.failure_decision(matches, Core.Persisting{attempt, intent, invocation}))) == Spec.Selected{attempt, intent} : Spec.SelectionView}:
  match matches:
    case True{}:
      {==}
    case False{}:
      {==}

def writing_ack_conserves(matches: Bool, +attempt: Nat, +intent: Core.Intent, invocation: Nat) -> {Spec.snapshot(Spec.state(Core.ack_decision(matches, Core.Persisting{attempt, intent, invocation}))) == Spec.Selected{attempt, intent} : Spec.SelectionView}:
  match matches:
    case True{}:
      {==}
    case False{}:
      {==}

def recovering_ack_conserves(matches: Bool, +attempt: Nat, +intent: Core.Intent, invocation: Nat) -> {Spec.snapshot(Spec.state(Core.ack_decision(matches, Core.Retryable{attempt, intent, invocation}))) == Spec.Selected{attempt, intent} : Spec.SelectionView}:
  match matches:
    case True{}:
      {==}
    case False{}:
      {==}

def retry_conserves(matches: Bool, +attempt: Nat, +intent: Core.Intent, previousInvocation: Nat, invocation: Nat) -> {Spec.snapshot(Spec.state(Core.retry_decision(matches, Core.Retryable{attempt, intent, previousInvocation}, invocation))) == Spec.Selected{attempt, intent} : Spec.SelectionView}:
  match matches:
    case True{}:
      {==}
    case False{}:
      {==}

def Laws.selected_intent_conserved(phase, attempt, intent, event):
  match phase event:
    case Spec.Writing{_} Core.Select{_, _, _}:
      {==}
    case Spec.Writing{+invocation} Core.StorageFailed{requestedAttempt, requestedOperation, requestedInvocation}:
      failure_conserves(Bool.and(Nat.is_eq(attempt, requestedAttempt), Bool.and(Nat.is_eq(Core.operation(intent), requestedOperation), Nat.is_eq(invocation, requestedInvocation))), attempt, intent, invocation)
    case Spec.Writing{_} Core.RetryPersistence{_, _, _}:
      {==}
    case Spec.Writing{invocation} Core.StoredAck{requestedAttempt, requestedIntent}:
      writing_ack_conserves(Bool.and(Nat.is_eq(attempt, requestedAttempt), Core.intent_matches(intent, requestedIntent)), attempt, intent, invocation)
    case Spec.Recovering{_} Core.Select{_, _, _}:
      {==}
    case Spec.Recovering{_} Core.StorageFailed{_, _, _}:
      {==}
    case Spec.Recovering{+previousInvocation} Core.RetryPersistence{requestedAttempt, requestedOperation, +requestedInvocation}:
      retry_conserves(Bool.and(Nat.is_eq(attempt, requestedAttempt), Bool.and(Nat.is_eq(Core.operation(intent), requestedOperation), Nat.is_gt(requestedInvocation, previousInvocation))), attempt, intent, previousInvocation, requestedInvocation)
    case Spec.Recovering{invocation} Core.StoredAck{requestedAttempt, requestedIntent}:
      recovering_ack_conserves(Bool.and(Nat.is_eq(attempt, requestedAttempt), Core.intent_matches(intent, requestedIntent)), attempt, intent, invocation)
    case Spec.Settled{} Core.Select{_, _, _}:
      {==}
    case Spec.Settled{} Core.StorageFailed{_, _, _}:
      {==}
    case Spec.Settled{} Core.RetryPersistence{_, _, _}:
      {==}
    case Spec.Settled{} Core.StoredAck{_, _}:
      {==}

# ---- acknowledgement_characterized ----
def writing_ack_agrees(matches: Bool, +attempt: Nat, +intent: Core.Intent, +invocation: Nat) -> {Core.ack_decision(matches, Core.Persisting{attempt, intent, invocation}) == Spec.acknowledgement_if(matches, Core.Persisting{attempt, intent, invocation}, attempt, intent) : Core.Decision}:
  match matches:
    case True{}:
      {==}
    case False{}:
      {==}

def recovering_ack_agrees(matches: Bool, +attempt: Nat, +intent: Core.Intent, +invocation: Nat) -> {Core.ack_decision(matches, Core.Retryable{attempt, intent, invocation}) == Spec.acknowledgement_if(matches, Core.Retryable{attempt, intent, invocation}, attempt, intent) : Core.Decision}:
  match matches:
    case True{}:
      {==}
    case False{}:
      {==}

def Laws.acknowledgement_characterized(state, attempt, intent):
  match state intent:
    case Core.Persisting{+currentAttempt, Core.Intent{+currentOperation, +currentPayload, Core.Completed{}}, invocation} Core.Intent{requestedOperation, requestedPayload, Core.Completed{}}:
      writing_ack_agrees(Bool.and(Nat.is_eq(currentAttempt, attempt), Bool.and(Nat.is_eq(currentOperation, requestedOperation), Bool.and(Nat.is_eq(currentPayload, requestedPayload), True{}))), currentAttempt, Core.Intent{currentOperation, currentPayload, Core.Completed{}}, invocation)
    case Core.Persisting{+currentAttempt, Core.Intent{+currentOperation, +currentPayload, Core.Completed{}}, invocation} Core.Intent{requestedOperation, requestedPayload, Core.Interrupted{}}:
      writing_ack_agrees(Bool.and(Nat.is_eq(currentAttempt, attempt), Bool.and(Nat.is_eq(currentOperation, requestedOperation), Bool.and(Nat.is_eq(currentPayload, requestedPayload), False{}))), currentAttempt, Core.Intent{currentOperation, currentPayload, Core.Completed{}}, invocation)
    case Core.Persisting{+currentAttempt, Core.Intent{+currentOperation, +currentPayload, Core.Interrupted{}}, invocation} Core.Intent{requestedOperation, requestedPayload, Core.Completed{}}:
      writing_ack_agrees(Bool.and(Nat.is_eq(currentAttempt, attempt), Bool.and(Nat.is_eq(currentOperation, requestedOperation), Bool.and(Nat.is_eq(currentPayload, requestedPayload), False{}))), currentAttempt, Core.Intent{currentOperation, currentPayload, Core.Interrupted{}}, invocation)
    case Core.Persisting{+currentAttempt, Core.Intent{+currentOperation, +currentPayload, Core.Interrupted{}}, invocation} Core.Intent{requestedOperation, requestedPayload, Core.Interrupted{}}:
      writing_ack_agrees(Bool.and(Nat.is_eq(currentAttempt, attempt), Bool.and(Nat.is_eq(currentOperation, requestedOperation), Bool.and(Nat.is_eq(currentPayload, requestedPayload), True{}))), currentAttempt, Core.Intent{currentOperation, currentPayload, Core.Interrupted{}}, invocation)
    case Core.Retryable{+currentAttempt, Core.Intent{+currentOperation, +currentPayload, Core.Completed{}}, invocation} Core.Intent{requestedOperation, requestedPayload, Core.Completed{}}:
      recovering_ack_agrees(Bool.and(Nat.is_eq(currentAttempt, attempt), Bool.and(Nat.is_eq(currentOperation, requestedOperation), Bool.and(Nat.is_eq(currentPayload, requestedPayload), True{}))), currentAttempt, Core.Intent{currentOperation, currentPayload, Core.Completed{}}, invocation)
    case Core.Retryable{+currentAttempt, Core.Intent{+currentOperation, +currentPayload, Core.Completed{}}, invocation} Core.Intent{requestedOperation, requestedPayload, Core.Interrupted{}}:
      recovering_ack_agrees(Bool.and(Nat.is_eq(currentAttempt, attempt), Bool.and(Nat.is_eq(currentOperation, requestedOperation), Bool.and(Nat.is_eq(currentPayload, requestedPayload), False{}))), currentAttempt, Core.Intent{currentOperation, currentPayload, Core.Completed{}}, invocation)
    case Core.Retryable{+currentAttempt, Core.Intent{+currentOperation, +currentPayload, Core.Interrupted{}}, invocation} Core.Intent{requestedOperation, requestedPayload, Core.Completed{}}:
      recovering_ack_agrees(Bool.and(Nat.is_eq(currentAttempt, attempt), Bool.and(Nat.is_eq(currentOperation, requestedOperation), Bool.and(Nat.is_eq(currentPayload, requestedPayload), False{}))), currentAttempt, Core.Intent{currentOperation, currentPayload, Core.Interrupted{}}, invocation)
    case Core.Retryable{+currentAttempt, Core.Intent{+currentOperation, +currentPayload, Core.Interrupted{}}, invocation} Core.Intent{requestedOperation, requestedPayload, Core.Interrupted{}}:
      recovering_ack_agrees(Bool.and(Nat.is_eq(currentAttempt, attempt), Bool.and(Nat.is_eq(currentOperation, requestedOperation), Bool.and(Nat.is_eq(currentPayload, requestedPayload), True{}))), currentAttempt, Core.Intent{currentOperation, currentPayload, Core.Interrupted{}}, invocation)
    case Core.Open{_} _:
      {==}
    case Core.Stored{_, _} _:
      {==}

# ---- retry_characterized ----
def retry_agrees(matches: Bool, +attempt: Nat, +intent: Core.Intent, +previousInvocation: Nat, +invocation: Nat) -> {Core.retry_decision(matches, Core.Retryable{attempt, intent, previousInvocation}, invocation) == Spec.retry_if(matches, attempt, intent, previousInvocation, invocation) : Core.Decision}:
  match matches:
    case True{}:
      {==}
    case False{}:
      {==}

def Laws.retry_characterized(state, attempt, operation, invocation):
  match state:
    case Core.Retryable{+currentAttempt, Core.Intent{+currentOperation, payload, outcome}, +previousInvocation}:
      retry_agrees(Bool.and(Nat.is_eq(currentAttempt, attempt), Bool.and(Nat.is_eq(currentOperation, operation), Nat.is_gt(invocation, previousInvocation))), currentAttempt, Core.Intent{currentOperation, payload, outcome}, previousInvocation, invocation)
    case Core.Open{_}:
      {==}
    case Core.Persisting{_, _, _}:
      {==}
    case Core.Stored{_, _}:
      {==}

# ---- stored_absorbing ----
def Laws.stored_absorbing(attempt, intent, event):
  match event:
    case Core.Select{_, _, _}:
      {==}
    case Core.StorageFailed{_, _, _}:
      {==}
    case Core.RetryPersistence{_, _, _}:
      {==}
    case Core.StoredAck{_, _}:
      {==}

# ---- failure_characterized ----
def failure_agrees(matches: Bool, +attempt: Nat, +intent: Core.Intent, +invocation: Nat) -> {Core.failure_decision(matches, Core.Persisting{attempt, intent, invocation}) == Spec.failure_if(matches, attempt, intent, invocation) : Core.Decision}:
  match matches:
    case True{}:
      {==}
    case False{}:
      {==}

def Laws.failure_characterized(state, attempt, operation, invocation):
  match state:
    case Core.Persisting{+currentAttempt, Core.Intent{+currentOperation, payload, outcome}, +currentInvocation}:
      failure_agrees(Bool.and(Nat.is_eq(currentAttempt, attempt), Bool.and(Nat.is_eq(currentOperation, operation), Nat.is_eq(currentInvocation, invocation))), currentAttempt, Core.Intent{currentOperation, payload, outcome}, currentInvocation)
    case Core.Open{_}:
      {==}
    case Core.Retryable{_, _, _}:
      {==}
    case Core.Stored{_, _}:
      {==}

# ---- initialization_characterized ----
def Laws.initialization_characterized(attempt):
  {==}
