import Base
import ./core.bend as Core
import ./Spec.bend as Spec

# Every transition preserves the immutable operation-to-payload association.
law intent_conserved:
  for +admission: Core.Admission
  for event: Core.AdmissionEvent
  {Spec.intent(Spec.state(Core.transition(admission, event))) == Spec.intent(admission) : Spec.Intent}

# Capture lifetime cannot erase or otherwise change handed admission work.
law capture_close_preserves:
  for +admission: Core.Admission
  {Core.transition(admission, Core.CaptureClosed{}) == Core.Decision{admission, Core.NoCommand{}} : Core.Decision}

# A revoked admission can never create a start command, at any phase.
law superseded_cannot_start:
  for +operation: Nat
  for payload: Nat
  for revision: Nat
  for phase: Core.Phase
  for event: Core.AdmissionEvent
  {Spec.starts(Spec.command(Core.transition(Core.Admission{operation, payload, revision, phase, Core.Superseded{}}, event))) == False{} : Bool}

# Eligible start authorization must make progress and retain the exact identity.
law eligible_authorization_starts:
  for +operation: Nat
  for +payload: Nat
  for +revision: Nat
  {Core.transition(Core.Admission{operation, payload, revision, Core.StartReserved{}, Core.Eligible{}}, Core.AuthorizeStart{operation}) == Core.Decision{Core.Admission{operation, payload, revision, Core.Started{}, Core.Eligible{}}, Core.StartResponse{operation, payload, revision}} : Core.Decision}

# A matching durable receipt is acknowledged, regardless of later eligibility.
law matching_acceptance_advances:
  for +operation: Nat
  for +payload: Nat
  for +revision: Nat
  for +eligibility: Core.Eligibility
  {Core.transition(Core.Admission{operation, payload, revision, Core.Pending{}, eligibility}, Core.Accepted{operation}) == Core.Decision{Core.Admission{operation, payload, revision, Core.AcceptedWaiting{}, eligibility}, Core.AcknowledgeReceipt{operation, payload}} : Core.Decision}

# Eligible accepted work reserves its asynchronous start preparation.
law eligible_prerequisite_advances:
  for +operation: Nat
  for +payload: Nat
  for +revision: Nat
  {Core.transition(Core.Admission{operation, payload, revision, Core.AcceptedWaiting{}, Core.Eligible{}}, Core.PrerequisiteReady{operation}) == Core.Decision{Core.Admission{operation, payload, revision, Core.StartReserved{}, Core.Eligible{}}, Core.RequestStart{operation, payload, revision}} : Core.Decision}

# An AuthorizeStart for another operation cannot change this admission.
law foreign_operation_ignored:
  for +admission: Core.Admission
  for +requested: Nat
  for mismatch: {Nat.is_eq(Spec.operation(admission), requested) == False{} : Bool}
  {Core.transition(admission, Core.AuthorizeStart{requested}) == Core.Decision{admission, Core.NoCommand{}} : Core.Decision}

# Independent source and Conversation clocks must both match before start is eligible.
law initialization_characterized:
  for +operation: Nat
  for +payload: Nat
  for +clock: Core.OriginClock
  {Core.initialize(operation, payload, clock) == Spec.initialize(operation, payload, clock) : Core.Admission}

# Retrying uncertain storage preserves its exact identity and makes progress.
law recoverable_retry_submits:
  for +operation: Nat
  for +payload: Nat
  for +revision: Nat
  for +eligibility: Core.Eligibility
  {Core.transition(Core.Admission{operation, payload, revision, Core.Recoverable{}, eligibility}, Core.Submit{operation}) == Core.Decision{Core.Admission{operation, payload, revision, Core.Pending{}, eligibility}, Core.Persist{operation, payload}} : Core.Decision}

# Superseded accepted input retains its interrupted-result recording obligation.
law superseded_settlement_requested:
  for +operation: Nat
  for +payload: Nat
  for +revision: Nat
  {Core.transition(Core.Admission{operation, payload, revision, Core.AcceptedWaiting{}, Core.Superseded{}}, Core.PrerequisiteReady{operation}) == Core.Decision{Core.Admission{operation, payload, revision, Core.SupersededReserved{}, Core.Superseded{}}, Core.RecordSuperseded{operation, payload, revision}} : Core.Decision}

# Fencing revokes eligibility; every other event preserves its previous value.
law eligibility_transition_characterized:
  for +admission: Core.Admission
  for +event: Core.AdmissionEvent
  {Spec.eligibility(Spec.state(Core.transition(admission, event))) == Spec.expected_eligibility(admission, event) : Core.Eligibility}
