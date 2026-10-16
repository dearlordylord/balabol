import assert from "node:assert/strict";

export function falsifyAdmission(core) {
  const phases = [
    "Reserved",
    "Pending",
    "AcceptedWaiting",
    "StartReserved",
    "SupersededReserved",
    "Started",
    "AcceptedExisting",
    "Recoverable",
    "Rejected",
  ];
  const correlatedEvents = [
    "Submit",
    "Accepted",
    "ExistingAccepted",
    "AdmissionFailed",
    "AdmissionRejected",
    "PrerequisiteReady",
    "AuthorizeStart",
  ];
  const intent = ({ operation, payload, revision }) => ({ operation, payload, revision });
  let cases = 0;
  for (const operation of [0n, 1n, 4294967295n, 281474976710655n])
    for (const phase of phases)
      for (const eligibility of ["Eligible", "Superseded"]) {
        const state = Object.freeze({
          $: "Admission",
          operation,
          payload: 281474976710655n,
          revision: 42n,
          phase: Object.freeze({ $: phase }),
          eligibility: Object.freeze({ $: eligibility }),
        });
        const events = correlatedEvents
          .flatMap(($) => [
            { $, operation },
            { $, operation: operation === 0n ? 1n : 0n },
          ])
          .concat([{ $: "Fence" }, { $: "CaptureClosed" }]);
        for (const event of events) {
          const decision = core.transition(state, event);
          assert.equal(
            decision.state.eligibility.$,
            event.$ === "Fence" ? "Superseded" : eligibility,
            "eligibility_transition_characterized",
          );
          assert.deepEqual(intent(decision.state), intent(state), "intent_conserved");
          if (event.$ === "CaptureClosed")
            assert.deepEqual(
              decision,
              { $: "Decision", state, command: { $: "NoCommand" } },
              "capture_close_preserves",
            );
          if (eligibility === "Superseded")
            assert.notEqual(decision.command.$, "StartResponse", "superseded_cannot_start");
          if ("operation" in event && event.operation !== operation)
            assert.deepEqual(
              decision,
              { $: "Decision", state, command: { $: "NoCommand" } },
              "foreign_operation_ignored",
            );
          if (
            event.$ === "AuthorizeStart" &&
            event.operation === operation &&
            phase === "StartReserved" &&
            eligibility === "Eligible"
          ) {
            assert.equal(decision.state.phase.$, "Started");
            assert.deepEqual(
              decision.command,
              { $: "StartResponse", ...intent(state) },
              "eligible_authorization_starts",
            );
          }
          if (event.$ === "Accepted" && event.operation === operation && phase === "Pending") {
            assert.equal(decision.state.phase.$, "AcceptedWaiting");
            assert.deepEqual(
              decision.command,
              { $: "AcknowledgeReceipt", operation, payload: state.payload },
              "matching_acceptance_advances",
            );
          }
          if (
            event.$ === "PrerequisiteReady" &&
            event.operation === operation &&
            phase === "AcceptedWaiting" &&
            eligibility === "Eligible"
          ) {
            assert.equal(decision.state.phase.$, "StartReserved");
            assert.deepEqual(
              decision.command,
              { $: "RequestStart", ...intent(state) },
              "eligible_prerequisite_advances",
            );
          }
          if (event.$ === "Submit" && event.operation === operation && phase === "Recoverable") {
            assert.equal(decision.state.phase.$, "Pending");
            assert.deepEqual(
              decision.command,
              { $: "Persist", operation, payload: state.payload },
              "recoverable_retry_submits",
            );
          }
          const repeated = core.transition(decision.state, event);
          assert.equal(repeated.command.$, "NoCommand", "duplicate event must not redispatch its command");
          if (event.$ === "Fence") {
            assert.equal(decision.state.eligibility.$, "Superseded");
            assert.equal(decision.state.phase.$, phase);
            assert.deepEqual(
              decision.command,
              eligibility === "Eligible" && (phase === "StartReserved" || phase === "Started")
                ? { $: "RevokeStart", operation }
                : { $: "NoCommand" },
            );
          }
          if (
            event.operation === operation &&
            eligibility === "Superseded" &&
            ((event.$ === "PrerequisiteReady" && phase === "AcceptedWaiting") ||
              (event.$ === "AuthorizeStart" && phase === "StartReserved"))
          ) {
            assert.equal(decision.state.phase.$, "SupersededReserved");
            assert.deepEqual(decision.command, { $: "RecordSuperseded", ...intent(state) });
          }
          if (
            event.operation === operation &&
            event.$ === "AdmissionFailed" &&
            (phase === "Reserved" || phase === "Pending")
          ) {
            assert.equal(decision.state.phase.$, "Recoverable");
            assert.deepEqual(decision.command, { $: "ReportFailure", operation });
          }
          cases++;
        }
      }
  for (const source of [0n, 1n, 281474976710655n])
    for (const current of [0n, 1n, 281474976710655n])
      for (const originRevision of [0n, 1n, 281474976710655n])
        for (const currentRevision of [0n, 1n, 281474976710655n]) {
          const state = core.initialize(42n, 43n, {
            $: "OriginClock",
            sourceSequence: source,
            currentSourceSequence: current,
            originRevision,
            currentRevision,
          });
          assert.equal(
            state.eligibility.$,
            source === current && originRevision === currentRevision ? "Eligible" : "Superseded",
            "initialization_characterized",
          );
          assert.deepEqual(intent(state), { operation: 42n, payload: 43n, revision: originRevision });
        }
  return cases;
}
