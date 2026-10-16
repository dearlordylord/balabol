const selected = "Core.Intent{13n, 17n, Core.Interrupted{}}";
const writing = `Core.Persisting{7n, ${selected}, 11n}`;
const recovering = `Core.Retryable{7n, ${selected}, 11n}`;

export const terminalMutants = [
  {
    law: "selection_characterized",
    name: "drop-initial-persistence-command",
    from: "case True{} Open{+attempt}:\n      Decision{Persisting{attempt, intent, invocation}, Persist{attempt, intent, invocation}}",
    to: "case True{} Open{+attempt}:\n      Decision{Persisting{attempt, intent, invocation}, NoCommand{}}",
    at: { state: "Core.Open{7n}", attempt: "7n", intent: selected, invocation: "11n" },
  },
  {
    law: "selection_characterized",
    name: "accept-foreign-selection",
    from: "select_decision(Nat.is_eq(attempt, requestedAttempt), Open{attempt}, intent, invocation)",
    to: "select_decision(True{}, Open{attempt}, intent, invocation)",
    at: { state: "Core.Open{7n}", attempt: "8n", intent: selected, invocation: "11n" },
  },
  {
    law: "selected_intent_conserved",
    name: "replace-selected-payload-and-outcome",
    from: "case True{} Persisting{attempt, intent, _}:\n      Decision{Stored{attempt, intent}, NoCommand{}}",
    to: "case True{} Persisting{attempt, intent, _}:\n      Decision{Stored{attempt, Intent{0n, 0n, Completed{}}}, NoCommand{}}",
    at: { phase: "Spec.Writing{11n}", attempt: "7n", intent: selected, event: `Core.StoredAck{7n, ${selected}}` },
  },
  {
    law: "acknowledgement_characterized",
    name: "ignore-acknowledgement-payload",
    from: "Bool.and(Nat.is_eq(leftOperation, rightOperation), Bool.and(Nat.is_eq(leftPayload, rightPayload), outcome_matches(leftOutcome, rightOutcome)))",
    to: "Bool.and(Nat.is_eq(leftOperation, rightOperation), outcome_matches(leftOutcome, rightOutcome))",
    at: { state: writing, attempt: "7n", intent: "Core.Intent{13n, 18n, Core.Interrupted{}}" },
  },
  {
    law: "acknowledgement_characterized",
    name: "ignore-acknowledgement-outcome",
    from: "Bool.and(Nat.is_eq(leftOperation, rightOperation), Bool.and(Nat.is_eq(leftPayload, rightPayload), outcome_matches(leftOutcome, rightOutcome)))",
    to: "Bool.and(Nat.is_eq(leftOperation, rightOperation), Nat.is_eq(leftPayload, rightPayload))",
    at: { state: writing, attempt: "7n", intent: "Core.Intent{13n, 17n, Core.Completed{}}" },
  },
  {
    law: "acknowledgement_characterized",
    name: "ignore-matching-durable-acknowledgement",
    from: "case True{} Persisting{attempt, intent, _}:\n      Decision{Stored{attempt, intent}, NoCommand{}}",
    to: "case True{} Persisting{attempt, intent, invocation}:\n      unchanged(Persisting{attempt, intent, invocation})",
    at: { state: writing, attempt: "7n", intent: selected },
  },
  {
    law: "retry_characterized",
    name: "drop-retry-persistence-command",
    from: "case True{} Retryable{+attempt, +intent, _}:\n      Decision{Persisting{attempt, intent, invocation}, Persist{attempt, intent, invocation}}",
    to: "case True{} Retryable{+attempt, +intent, _}:\n      Decision{Persisting{attempt, intent, invocation}, NoCommand{}}",
    at: { state: recovering, attempt: "7n", operation: "13n", invocation: "12n" },
  },
  {
    law: "retry_characterized",
    name: "reuse-previous-invocation",
    from: "Nat.is_gt(requestedInvocation, previousInvocation)",
    to: "Nat.is_ge(requestedInvocation, previousInvocation)",
    at: { state: recovering, attempt: "7n", operation: "13n", invocation: "11n" },
  },
  {
    law: "retry_characterized",
    name: "dispatch-a-concurrent-retry",
    from: "def retry(state: TerminalState, requestedAttempt: Nat, requestedOperation: Nat, +requestedInvocation: Nat) -> Decision:\n  match state:",
    to: "def retry(state: TerminalState, requestedAttempt: Nat, requestedOperation: Nat, +requestedInvocation: Nat) -> Decision:\n  match state:\n    case Persisting{attempt, intent, invocation}:\n      retry_decision(True{}, Retryable{attempt, intent, invocation}, requestedInvocation)",
    at: { state: writing, attempt: "7n", operation: "13n", invocation: "12n" },
  },
  {
    law: "stored_absorbing",
    name: "select-after-stored",
    from: "def select(state: TerminalState, requestedAttempt: Nat, intent: Intent, invocation: Nat) -> Decision:\n  match state:",
    to: "def select(state: TerminalState, requestedAttempt: Nat, intent: Intent, invocation: Nat) -> Decision:\n  match state:\n    case Stored{attempt, _}:\n      select_decision(True{}, Open{attempt}, intent, invocation)",
    at: { attempt: "7n", intent: selected, event: "Core.Select{7n, Core.Intent{14n, 18n, Core.Completed{}}, 12n}" },
  },
  {
    law: "failure_characterized",
    name: "accept-old-invocation-failure",
    from: "Nat.is_eq(invocation, requestedInvocation)",
    to: "True{}",
    at: {
      state: "Core.Persisting{7n, Core.Intent{13n, 17n, Core.Interrupted{}}, 12n}",
      attempt: "7n",
      operation: "13n",
      invocation: "11n",
    },
  },
  {
    law: "selected_intent_conserved",
    name: "erase-intent-on-storage-failure",
    from: "Decision{Retryable{attempt, intent, invocation}, NoCommand{}}",
    to: "Decision{Open{attempt}, NoCommand{}}",
    at: { phase: "Spec.Writing{11n}", attempt: "7n", intent: selected, event: "Core.StorageFailed{7n, 13n, 11n}" },
  },
  {
    law: "failure_characterized",
    name: "ignore-matching-storage-failure",
    from: "Decision{Retryable{attempt, intent, invocation}, NoCommand{}}",
    to: "unchanged(Persisting{attempt, intent, invocation})",
    at: { state: writing, attempt: "7n", operation: "13n", invocation: "11n" },
  },
  {
    law: "initialization_characterized",
    name: "initialize-already-stored",
    from: "def initialize(attempt: Nat) -> TerminalState:\n  Open{attempt}",
    to: "def initialize(attempt: Nat) -> TerminalState:\n  Stored{attempt, Intent{0n, 0n, Completed{}}}",
    at: { attempt: "7n" },
  },
];
