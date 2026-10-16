import assert from "node:assert/strict";

const maximum = 281474976710655n;
const other = (value) => (value === 0n ? 1n : 0n);
const intent = (operation, payload, outcome) => ({ $: "Intent", operation, payload, outcome: { $: outcome } });
const equalIntent = (left, right) =>
  left.operation === right.operation && left.payload === right.payload && left.outcome.$ === right.outcome.$;
const unchanged = (state) => ({ $: "Decision", state, command: { $: "NoCommand" } });

// This finite oracle states only the selected terminal protocol, not provider or
// scheduling behavior. Expected answers never call the compiled implementation.
function expected(state, event) {
  if (event.$ === "Select") {
    if (state.$ !== "Open" || state.attempt !== event.attempt) return unchanged(state);
    return {
      $: "Decision",
      state: { $: "Persisting", attempt: state.attempt, intent: event.intent, invocation: event.invocation },
      command: { $: "Persist", attempt: state.attempt, intent: event.intent, invocation: event.invocation },
    };
  }
  if (event.$ === "StoredAck") {
    if (
      !["Persisting", "Retryable"].includes(state.$) ||
      state.attempt !== event.attempt ||
      !equalIntent(state.intent, event.intent)
    )
      return unchanged(state);
    return unchanged({ $: "Stored", attempt: state.attempt, intent: state.intent });
  }
  if (event.$ === "StorageFailed") {
    if (
      state.$ !== "Persisting" ||
      state.attempt !== event.attempt ||
      state.intent.operation !== event.operation ||
      state.invocation !== event.invocation
    )
      return unchanged(state);
    return unchanged({ ...state, $: "Retryable" });
  }
  if (
    state.$ !== "Retryable" ||
    state.attempt !== event.attempt ||
    state.intent.operation !== event.operation ||
    event.invocation <= state.invocation
  )
    return unchanged(state);
  return {
    $: "Decision",
    state: { ...state, $: "Persisting", invocation: event.invocation },
    command: { $: "Persist", attempt: state.attempt, intent: state.intent, invocation: event.invocation },
  };
}

function eventsFor(state) {
  const selected = state.intent ?? intent(7n, 13n, "Completed");
  const invocation = state.invocation ?? 11n;
  const alternateOutcome = selected.outcome.$ === "Completed" ? "Interrupted" : "Completed";
  const variants = [
    selected,
    { ...selected, operation: other(selected.operation) },
    { ...selected, payload: other(selected.payload) },
    { ...selected, outcome: { $: alternateOutcome } },
  ];
  const invocations = [
    ...new Set([
      0n,
      invocation,
      invocation > 0n ? invocation - 1n : 0n,
      invocation < maximum ? invocation + 1n : maximum,
      maximum,
    ]),
  ];
  return [
    ...variants.flatMap((value) => [
      { $: "Select", attempt: state.attempt, intent: value, invocation },
      { $: "Select", attempt: other(state.attempt), intent: value, invocation },
      { $: "StoredAck", attempt: state.attempt, intent: value },
      { $: "StoredAck", attempt: other(state.attempt), intent: value },
    ]),
    ...invocations.flatMap((value) =>
      ["StorageFailed", "RetryPersistence"].flatMap(($) => [
        { $, attempt: state.attempt, operation: selected.operation, invocation: value },
        { $, attempt: other(state.attempt), operation: selected.operation, invocation: value },
        { $, attempt: state.attempt, operation: other(selected.operation), invocation: value },
      ]),
    ),
  ];
}

export function falsifyTerminal(core) {
  let cases = 0;
  const advance = (state, event) => {
    const decision = core.transition(state, event);
    assert.deepEqual(decision, expected(state, event), "reachable trace advancement");
    return decision.state;
  };
  for (const attempt of [0n, 7n, maximum])
    for (const operation of [0n, 13n, maximum])
      for (const outcome of ["Completed", "Interrupted"])
        for (const invocation of [0n, 11n, maximum - 1n]) {
          const selected = intent(operation, maximum, outcome);
          const open = core.initialize(attempt);
          assert.deepEqual(open, { $: "Open", attempt });
          const writing = advance(open, { $: "Select", attempt, intent: selected, invocation });
          const recovering = advance(writing, { $: "StorageFailed", attempt, operation, invocation });
          const retrying = advance(recovering, {
            $: "RetryPersistence",
            attempt,
            operation,
            invocation: invocation + 1n,
          });
          const stored = advance(retrying, { $: "StoredAck", attempt, intent: selected });
          for (const state of [open, writing, recovering, retrying, stored]) {
            const frozen = Object.freeze({
              ...state,
              ...(state.intent
                ? { intent: Object.freeze({ ...state.intent, outcome: Object.freeze({ ...state.intent.outcome }) }) }
                : {}),
            });
            for (const event of eventsFor(state)) {
              const result = core.transition(frozen, event);
              assert.deepEqual(result, expected(state, event), `terminal protocol ${state.$}/${event.$}`);
              if (state.intent) {
                assert.deepEqual(result.state.intent, state.intent, "selected_intent_conserved");
                assert.equal(result.state.attempt, state.attempt);
              }
              cases++;
            }
          }
          // A late negative completion must not reopen the newer write. An
          // actual durable receipt remains sufficient, independent of dispatch.
          assert.deepEqual(
            core.transition(retrying, { $: "StorageFailed", attempt, operation, invocation }),
            unchanged(retrying),
          );
          assert.deepEqual(core.transition(retrying, { $: "StoredAck", attempt, intent: selected }), unchanged(stored));
        }
  return cases;
}
