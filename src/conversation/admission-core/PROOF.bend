import Base
import ./core.bend as Core
import ./Spec.bend as Spec
import ./LAWS.bend as Laws

# Shared arithmetic fact, independent of admission implementation.
def same_operation(+operation: Nat) -> {True{} == Nat.is_eq(operation, operation) : Bool}:
  match operation:
    case 0n:
      {==}
    case 1n+previous:
      same_operation(previous)

# ---- intent_conserved ----
def intent_apply(+admission: Core.Admission, event: Core.AdmissionEvent) -> {Spec.intent(Spec.state(Core.apply(admission, event))) == Spec.intent(admission) : Spec.Intent}:
  match admission event:
    case Core.Admission{+operation, +payload, +revision, Core.Reserved{}, Core.Eligible{}} Core.Submit{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Reserved{}, Core.Eligible{}} Core.Accepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Reserved{}, Core.Eligible{}} Core.ExistingAccepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Reserved{}, Core.Eligible{}} Core.AdmissionFailed{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Reserved{}, Core.Eligible{}} Core.AdmissionRejected{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Reserved{}, Core.Eligible{}} Core.PrerequisiteReady{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Reserved{}, Core.Eligible{}} Core.AuthorizeStart{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Reserved{}, Core.Eligible{}} Core.Fence{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Reserved{}, Core.Eligible{}} Core.CaptureClosed{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Reserved{}, Core.Superseded{}} Core.Submit{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Reserved{}, Core.Superseded{}} Core.Accepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Reserved{}, Core.Superseded{}} Core.ExistingAccepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Reserved{}, Core.Superseded{}} Core.AdmissionFailed{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Reserved{}, Core.Superseded{}} Core.AdmissionRejected{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Reserved{}, Core.Superseded{}} Core.PrerequisiteReady{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Reserved{}, Core.Superseded{}} Core.AuthorizeStart{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Reserved{}, Core.Superseded{}} Core.Fence{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Reserved{}, Core.Superseded{}} Core.CaptureClosed{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Pending{}, Core.Eligible{}} Core.Submit{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Pending{}, Core.Eligible{}} Core.Accepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Pending{}, Core.Eligible{}} Core.ExistingAccepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Pending{}, Core.Eligible{}} Core.AdmissionFailed{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Pending{}, Core.Eligible{}} Core.AdmissionRejected{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Pending{}, Core.Eligible{}} Core.PrerequisiteReady{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Pending{}, Core.Eligible{}} Core.AuthorizeStart{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Pending{}, Core.Eligible{}} Core.Fence{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Pending{}, Core.Eligible{}} Core.CaptureClosed{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Pending{}, Core.Superseded{}} Core.Submit{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Pending{}, Core.Superseded{}} Core.Accepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Pending{}, Core.Superseded{}} Core.ExistingAccepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Pending{}, Core.Superseded{}} Core.AdmissionFailed{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Pending{}, Core.Superseded{}} Core.AdmissionRejected{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Pending{}, Core.Superseded{}} Core.PrerequisiteReady{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Pending{}, Core.Superseded{}} Core.AuthorizeStart{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Pending{}, Core.Superseded{}} Core.Fence{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Pending{}, Core.Superseded{}} Core.CaptureClosed{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedWaiting{}, Core.Eligible{}} Core.Submit{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedWaiting{}, Core.Eligible{}} Core.Accepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedWaiting{}, Core.Eligible{}} Core.ExistingAccepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedWaiting{}, Core.Eligible{}} Core.AdmissionFailed{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedWaiting{}, Core.Eligible{}} Core.AdmissionRejected{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedWaiting{}, Core.Eligible{}} Core.PrerequisiteReady{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedWaiting{}, Core.Eligible{}} Core.AuthorizeStart{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedWaiting{}, Core.Eligible{}} Core.Fence{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedWaiting{}, Core.Eligible{}} Core.CaptureClosed{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedWaiting{}, Core.Superseded{}} Core.Submit{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedWaiting{}, Core.Superseded{}} Core.Accepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedWaiting{}, Core.Superseded{}} Core.ExistingAccepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedWaiting{}, Core.Superseded{}} Core.AdmissionFailed{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedWaiting{}, Core.Superseded{}} Core.AdmissionRejected{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedWaiting{}, Core.Superseded{}} Core.PrerequisiteReady{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedWaiting{}, Core.Superseded{}} Core.AuthorizeStart{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedWaiting{}, Core.Superseded{}} Core.Fence{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedWaiting{}, Core.Superseded{}} Core.CaptureClosed{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.StartReserved{}, Core.Eligible{}} Core.Submit{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.StartReserved{}, Core.Eligible{}} Core.Accepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.StartReserved{}, Core.Eligible{}} Core.ExistingAccepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.StartReserved{}, Core.Eligible{}} Core.AdmissionFailed{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.StartReserved{}, Core.Eligible{}} Core.AdmissionRejected{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.StartReserved{}, Core.Eligible{}} Core.PrerequisiteReady{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.StartReserved{}, Core.Eligible{}} Core.AuthorizeStart{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.StartReserved{}, Core.Eligible{}} Core.Fence{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.StartReserved{}, Core.Eligible{}} Core.CaptureClosed{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.StartReserved{}, Core.Superseded{}} Core.Submit{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.StartReserved{}, Core.Superseded{}} Core.Accepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.StartReserved{}, Core.Superseded{}} Core.ExistingAccepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.StartReserved{}, Core.Superseded{}} Core.AdmissionFailed{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.StartReserved{}, Core.Superseded{}} Core.AdmissionRejected{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.StartReserved{}, Core.Superseded{}} Core.PrerequisiteReady{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.StartReserved{}, Core.Superseded{}} Core.AuthorizeStart{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.StartReserved{}, Core.Superseded{}} Core.Fence{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.StartReserved{}, Core.Superseded{}} Core.CaptureClosed{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.SupersededReserved{}, Core.Eligible{}} Core.Submit{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.SupersededReserved{}, Core.Eligible{}} Core.Accepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.SupersededReserved{}, Core.Eligible{}} Core.ExistingAccepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.SupersededReserved{}, Core.Eligible{}} Core.AdmissionFailed{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.SupersededReserved{}, Core.Eligible{}} Core.AdmissionRejected{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.SupersededReserved{}, Core.Eligible{}} Core.PrerequisiteReady{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.SupersededReserved{}, Core.Eligible{}} Core.AuthorizeStart{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.SupersededReserved{}, Core.Eligible{}} Core.Fence{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.SupersededReserved{}, Core.Eligible{}} Core.CaptureClosed{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.SupersededReserved{}, Core.Superseded{}} Core.Submit{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.SupersededReserved{}, Core.Superseded{}} Core.Accepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.SupersededReserved{}, Core.Superseded{}} Core.ExistingAccepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.SupersededReserved{}, Core.Superseded{}} Core.AdmissionFailed{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.SupersededReserved{}, Core.Superseded{}} Core.AdmissionRejected{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.SupersededReserved{}, Core.Superseded{}} Core.PrerequisiteReady{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.SupersededReserved{}, Core.Superseded{}} Core.AuthorizeStart{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.SupersededReserved{}, Core.Superseded{}} Core.Fence{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.SupersededReserved{}, Core.Superseded{}} Core.CaptureClosed{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Started{}, Core.Eligible{}} Core.Submit{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Started{}, Core.Eligible{}} Core.Accepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Started{}, Core.Eligible{}} Core.ExistingAccepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Started{}, Core.Eligible{}} Core.AdmissionFailed{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Started{}, Core.Eligible{}} Core.AdmissionRejected{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Started{}, Core.Eligible{}} Core.PrerequisiteReady{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Started{}, Core.Eligible{}} Core.AuthorizeStart{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Started{}, Core.Eligible{}} Core.Fence{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Started{}, Core.Eligible{}} Core.CaptureClosed{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Started{}, Core.Superseded{}} Core.Submit{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Started{}, Core.Superseded{}} Core.Accepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Started{}, Core.Superseded{}} Core.ExistingAccepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Started{}, Core.Superseded{}} Core.AdmissionFailed{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Started{}, Core.Superseded{}} Core.AdmissionRejected{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Started{}, Core.Superseded{}} Core.PrerequisiteReady{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Started{}, Core.Superseded{}} Core.AuthorizeStart{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Started{}, Core.Superseded{}} Core.Fence{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Started{}, Core.Superseded{}} Core.CaptureClosed{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedExisting{}, Core.Eligible{}} Core.Submit{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedExisting{}, Core.Eligible{}} Core.Accepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedExisting{}, Core.Eligible{}} Core.ExistingAccepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedExisting{}, Core.Eligible{}} Core.AdmissionFailed{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedExisting{}, Core.Eligible{}} Core.AdmissionRejected{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedExisting{}, Core.Eligible{}} Core.PrerequisiteReady{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedExisting{}, Core.Eligible{}} Core.AuthorizeStart{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedExisting{}, Core.Eligible{}} Core.Fence{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedExisting{}, Core.Eligible{}} Core.CaptureClosed{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedExisting{}, Core.Superseded{}} Core.Submit{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedExisting{}, Core.Superseded{}} Core.Accepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedExisting{}, Core.Superseded{}} Core.ExistingAccepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedExisting{}, Core.Superseded{}} Core.AdmissionFailed{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedExisting{}, Core.Superseded{}} Core.AdmissionRejected{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedExisting{}, Core.Superseded{}} Core.PrerequisiteReady{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedExisting{}, Core.Superseded{}} Core.AuthorizeStart{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedExisting{}, Core.Superseded{}} Core.Fence{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedExisting{}, Core.Superseded{}} Core.CaptureClosed{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Recoverable{}, Core.Eligible{}} Core.Submit{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Recoverable{}, Core.Eligible{}} Core.Accepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Recoverable{}, Core.Eligible{}} Core.ExistingAccepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Recoverable{}, Core.Eligible{}} Core.AdmissionFailed{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Recoverable{}, Core.Eligible{}} Core.AdmissionRejected{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Recoverable{}, Core.Eligible{}} Core.PrerequisiteReady{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Recoverable{}, Core.Eligible{}} Core.AuthorizeStart{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Recoverable{}, Core.Eligible{}} Core.Fence{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Recoverable{}, Core.Eligible{}} Core.CaptureClosed{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Recoverable{}, Core.Superseded{}} Core.Submit{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Recoverable{}, Core.Superseded{}} Core.Accepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Recoverable{}, Core.Superseded{}} Core.ExistingAccepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Recoverable{}, Core.Superseded{}} Core.AdmissionFailed{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Recoverable{}, Core.Superseded{}} Core.AdmissionRejected{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Recoverable{}, Core.Superseded{}} Core.PrerequisiteReady{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Recoverable{}, Core.Superseded{}} Core.AuthorizeStart{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Recoverable{}, Core.Superseded{}} Core.Fence{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Recoverable{}, Core.Superseded{}} Core.CaptureClosed{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Rejected{}, Core.Eligible{}} Core.Submit{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Rejected{}, Core.Eligible{}} Core.Accepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Rejected{}, Core.Eligible{}} Core.ExistingAccepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Rejected{}, Core.Eligible{}} Core.AdmissionFailed{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Rejected{}, Core.Eligible{}} Core.AdmissionRejected{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Rejected{}, Core.Eligible{}} Core.PrerequisiteReady{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Rejected{}, Core.Eligible{}} Core.AuthorizeStart{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Rejected{}, Core.Eligible{}} Core.Fence{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Rejected{}, Core.Eligible{}} Core.CaptureClosed{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Rejected{}, Core.Superseded{}} Core.Submit{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Rejected{}, Core.Superseded{}} Core.Accepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Rejected{}, Core.Superseded{}} Core.ExistingAccepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Rejected{}, Core.Superseded{}} Core.AdmissionFailed{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Rejected{}, Core.Superseded{}} Core.AdmissionRejected{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Rejected{}, Core.Superseded{}} Core.PrerequisiteReady{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Rejected{}, Core.Superseded{}} Core.AuthorizeStart{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Rejected{}, Core.Superseded{}} Core.Fence{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Rejected{}, Core.Superseded{}} Core.CaptureClosed{}:
      {==}

def intent_fence(+admission: Core.Admission) -> {Spec.intent(Spec.state(Core.fence(admission))) == Spec.intent(admission) : Spec.Intent}:
  match admission:
    case Core.Admission{+operation, +payload, +revision, Core.Reserved{}, Core.Eligible{}}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Reserved{}, Core.Superseded{}}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Pending{}, Core.Eligible{}}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Pending{}, Core.Superseded{}}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedWaiting{}, Core.Eligible{}}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedWaiting{}, Core.Superseded{}}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.StartReserved{}, Core.Eligible{}}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.StartReserved{}, Core.Superseded{}}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.SupersededReserved{}, Core.Eligible{}}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.SupersededReserved{}, Core.Superseded{}}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Started{}, Core.Eligible{}}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Started{}, Core.Superseded{}}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedExisting{}, Core.Eligible{}}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedExisting{}, Core.Superseded{}}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Recoverable{}, Core.Eligible{}}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Recoverable{}, Core.Superseded{}}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Rejected{}, Core.Eligible{}}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Rejected{}, Core.Superseded{}}:
      {==}

def intent_correlated(matches: Bool, +admission: Core.Admission, event: Core.AdmissionEvent) -> {Spec.intent(Spec.state(Core.correlated(matches, admission, event))) == Spec.intent(admission) : Spec.Intent}:
  match matches:
    case True{}:
      intent_apply(admission, event)
    case False{}:
      {==}

def Laws.intent_conserved(admission, event):
  match event:
    case Core.Submit{+requested}:
      intent_correlated(Nat.is_eq(Core.operation(admission), requested), admission, Core.Submit{requested})
    case Core.Accepted{+requested}:
      intent_correlated(Nat.is_eq(Core.operation(admission), requested), admission, Core.Accepted{requested})
    case Core.ExistingAccepted{+requested}:
      intent_correlated(Nat.is_eq(Core.operation(admission), requested), admission, Core.ExistingAccepted{requested})
    case Core.AdmissionFailed{+requested}:
      intent_correlated(Nat.is_eq(Core.operation(admission), requested), admission, Core.AdmissionFailed{requested})
    case Core.AdmissionRejected{+requested}:
      intent_correlated(Nat.is_eq(Core.operation(admission), requested), admission, Core.AdmissionRejected{requested})
    case Core.PrerequisiteReady{+requested}:
      intent_correlated(Nat.is_eq(Core.operation(admission), requested), admission, Core.PrerequisiteReady{requested})
    case Core.AuthorizeStart{+requested}:
      intent_correlated(Nat.is_eq(Core.operation(admission), requested), admission, Core.AuthorizeStart{requested})
    case Core.Fence{}:
      intent_fence(admission)
    case Core.CaptureClosed{}:
      {==}

# ---- capture_close_preserves ----
def Laws.capture_close_preserves(admission):
  {==}

# ---- superseded_cannot_start ----
def superseded_apply(operation: Nat, payload: Nat, revision: Nat, phase: Core.Phase, event: Core.AdmissionEvent) -> {Spec.starts(Spec.command(Core.apply(Core.Admission{operation, payload, revision, phase, Core.Superseded{}}, event))) == False{} : Bool}:
  match phase event:
    case Core.Reserved{} Core.Submit{_}:
      {==}
    case Core.Reserved{} Core.Accepted{_}:
      {==}
    case Core.Reserved{} Core.ExistingAccepted{_}:
      {==}
    case Core.Reserved{} Core.AdmissionFailed{_}:
      {==}
    case Core.Reserved{} Core.AdmissionRejected{_}:
      {==}
    case Core.Reserved{} Core.PrerequisiteReady{_}:
      {==}
    case Core.Reserved{} Core.AuthorizeStart{_}:
      {==}
    case Core.Reserved{} Core.Fence{}:
      {==}
    case Core.Reserved{} Core.CaptureClosed{}:
      {==}
    case Core.Pending{} Core.Submit{_}:
      {==}
    case Core.Pending{} Core.Accepted{_}:
      {==}
    case Core.Pending{} Core.ExistingAccepted{_}:
      {==}
    case Core.Pending{} Core.AdmissionFailed{_}:
      {==}
    case Core.Pending{} Core.AdmissionRejected{_}:
      {==}
    case Core.Pending{} Core.PrerequisiteReady{_}:
      {==}
    case Core.Pending{} Core.AuthorizeStart{_}:
      {==}
    case Core.Pending{} Core.Fence{}:
      {==}
    case Core.Pending{} Core.CaptureClosed{}:
      {==}
    case Core.AcceptedWaiting{} Core.Submit{_}:
      {==}
    case Core.AcceptedWaiting{} Core.Accepted{_}:
      {==}
    case Core.AcceptedWaiting{} Core.ExistingAccepted{_}:
      {==}
    case Core.AcceptedWaiting{} Core.AdmissionFailed{_}:
      {==}
    case Core.AcceptedWaiting{} Core.AdmissionRejected{_}:
      {==}
    case Core.AcceptedWaiting{} Core.PrerequisiteReady{_}:
      {==}
    case Core.AcceptedWaiting{} Core.AuthorizeStart{_}:
      {==}
    case Core.AcceptedWaiting{} Core.Fence{}:
      {==}
    case Core.AcceptedWaiting{} Core.CaptureClosed{}:
      {==}
    case Core.StartReserved{} Core.Submit{_}:
      {==}
    case Core.StartReserved{} Core.Accepted{_}:
      {==}
    case Core.StartReserved{} Core.ExistingAccepted{_}:
      {==}
    case Core.StartReserved{} Core.AdmissionFailed{_}:
      {==}
    case Core.StartReserved{} Core.AdmissionRejected{_}:
      {==}
    case Core.StartReserved{} Core.PrerequisiteReady{_}:
      {==}
    case Core.StartReserved{} Core.AuthorizeStart{_}:
      {==}
    case Core.StartReserved{} Core.Fence{}:
      {==}
    case Core.StartReserved{} Core.CaptureClosed{}:
      {==}
    case Core.SupersededReserved{} Core.Submit{_}:
      {==}
    case Core.SupersededReserved{} Core.Accepted{_}:
      {==}
    case Core.SupersededReserved{} Core.ExistingAccepted{_}:
      {==}
    case Core.SupersededReserved{} Core.AdmissionFailed{_}:
      {==}
    case Core.SupersededReserved{} Core.AdmissionRejected{_}:
      {==}
    case Core.SupersededReserved{} Core.PrerequisiteReady{_}:
      {==}
    case Core.SupersededReserved{} Core.AuthorizeStart{_}:
      {==}
    case Core.SupersededReserved{} Core.Fence{}:
      {==}
    case Core.SupersededReserved{} Core.CaptureClosed{}:
      {==}
    case Core.Started{} Core.Submit{_}:
      {==}
    case Core.Started{} Core.Accepted{_}:
      {==}
    case Core.Started{} Core.ExistingAccepted{_}:
      {==}
    case Core.Started{} Core.AdmissionFailed{_}:
      {==}
    case Core.Started{} Core.AdmissionRejected{_}:
      {==}
    case Core.Started{} Core.PrerequisiteReady{_}:
      {==}
    case Core.Started{} Core.AuthorizeStart{_}:
      {==}
    case Core.Started{} Core.Fence{}:
      {==}
    case Core.Started{} Core.CaptureClosed{}:
      {==}
    case Core.AcceptedExisting{} Core.Submit{_}:
      {==}
    case Core.AcceptedExisting{} Core.Accepted{_}:
      {==}
    case Core.AcceptedExisting{} Core.ExistingAccepted{_}:
      {==}
    case Core.AcceptedExisting{} Core.AdmissionFailed{_}:
      {==}
    case Core.AcceptedExisting{} Core.AdmissionRejected{_}:
      {==}
    case Core.AcceptedExisting{} Core.PrerequisiteReady{_}:
      {==}
    case Core.AcceptedExisting{} Core.AuthorizeStart{_}:
      {==}
    case Core.AcceptedExisting{} Core.Fence{}:
      {==}
    case Core.AcceptedExisting{} Core.CaptureClosed{}:
      {==}
    case Core.Recoverable{} Core.Submit{_}:
      {==}
    case Core.Recoverable{} Core.Accepted{_}:
      {==}
    case Core.Recoverable{} Core.ExistingAccepted{_}:
      {==}
    case Core.Recoverable{} Core.AdmissionFailed{_}:
      {==}
    case Core.Recoverable{} Core.AdmissionRejected{_}:
      {==}
    case Core.Recoverable{} Core.PrerequisiteReady{_}:
      {==}
    case Core.Recoverable{} Core.AuthorizeStart{_}:
      {==}
    case Core.Recoverable{} Core.Fence{}:
      {==}
    case Core.Recoverable{} Core.CaptureClosed{}:
      {==}
    case Core.Rejected{} Core.Submit{_}:
      {==}
    case Core.Rejected{} Core.Accepted{_}:
      {==}
    case Core.Rejected{} Core.ExistingAccepted{_}:
      {==}
    case Core.Rejected{} Core.AdmissionFailed{_}:
      {==}
    case Core.Rejected{} Core.AdmissionRejected{_}:
      {==}
    case Core.Rejected{} Core.PrerequisiteReady{_}:
      {==}
    case Core.Rejected{} Core.AuthorizeStart{_}:
      {==}
    case Core.Rejected{} Core.Fence{}:
      {==}
    case Core.Rejected{} Core.CaptureClosed{}:
      {==}
    case _ _:
      {==}

def superseded_fence(operation: Nat, payload: Nat, revision: Nat, phase: Core.Phase) -> {Spec.starts(Spec.command(Core.fence(Core.Admission{operation, payload, revision, phase, Core.Superseded{}}))) == False{} : Bool}:
  match phase:
    case Core.Reserved{}:
      {==}
    case Core.Pending{}:
      {==}
    case Core.AcceptedWaiting{}:
      {==}
    case Core.StartReserved{}:
      {==}
    case Core.SupersededReserved{}:
      {==}
    case Core.Started{}:
      {==}
    case Core.AcceptedExisting{}:
      {==}
    case Core.Recoverable{}:
      {==}
    case Core.Rejected{}:
      {==}

def superseded_correlated(matches: Bool, operation: Nat, payload: Nat, revision: Nat, phase: Core.Phase, event: Core.AdmissionEvent) -> {Spec.starts(Spec.command(Core.correlated(matches, Core.Admission{operation, payload, revision, phase, Core.Superseded{}}, event))) == False{} : Bool}:
  match matches:
    case True{}:
      superseded_apply(operation, payload, revision, phase, event)
    case False{}:
      {==}

def Laws.superseded_cannot_start(operation, payload, revision, phase, event):
  match event:
    case Core.Submit{+requested}:
      superseded_correlated(Nat.is_eq(operation, requested), operation, payload, revision, phase, Core.Submit{requested})
    case Core.Accepted{+requested}:
      superseded_correlated(Nat.is_eq(operation, requested), operation, payload, revision, phase, Core.Accepted{requested})
    case Core.ExistingAccepted{+requested}:
      superseded_correlated(Nat.is_eq(operation, requested), operation, payload, revision, phase, Core.ExistingAccepted{requested})
    case Core.AdmissionFailed{+requested}:
      superseded_correlated(Nat.is_eq(operation, requested), operation, payload, revision, phase, Core.AdmissionFailed{requested})
    case Core.AdmissionRejected{+requested}:
      superseded_correlated(Nat.is_eq(operation, requested), operation, payload, revision, phase, Core.AdmissionRejected{requested})
    case Core.PrerequisiteReady{+requested}:
      superseded_correlated(Nat.is_eq(operation, requested), operation, payload, revision, phase, Core.PrerequisiteReady{requested})
    case Core.AuthorizeStart{+requested}:
      superseded_correlated(Nat.is_eq(operation, requested), operation, payload, revision, phase, Core.AuthorizeStart{requested})
    case Core.Fence{}:
      superseded_fence(operation, payload, revision, phase)
    case Core.CaptureClosed{}:
      {==}

# ---- eligible_authorization_starts ----
def Laws.eligible_authorization_starts(operation, payload, revision):
  %same_operation(operation) : {Core.correlated(_, Core.Admission{operation, payload, revision, Core.StartReserved{}, Core.Eligible{}}, Core.AuthorizeStart{operation}) == Core.Decision{Core.Admission{operation, payload, revision, Core.Started{}, Core.Eligible{}}, Core.StartResponse{operation, payload, revision}} : Core.Decision}
  {==}

# ---- matching_acceptance_advances ----
def Laws.matching_acceptance_advances(operation, payload, revision, eligibility):
  %same_operation(operation) : {Core.correlated(_, Core.Admission{operation, payload, revision, Core.Pending{}, eligibility}, Core.Accepted{operation}) == Core.Decision{Core.Admission{operation, payload, revision, Core.AcceptedWaiting{}, eligibility}, Core.AcknowledgeReceipt{operation, payload}} : Core.Decision}
  {==}

# ---- eligible_prerequisite_advances ----
def Laws.eligible_prerequisite_advances(operation, payload, revision):
  %same_operation(operation) : {Core.correlated(_, Core.Admission{operation, payload, revision, Core.AcceptedWaiting{}, Core.Eligible{}}, Core.PrerequisiteReady{operation}) == Core.Decision{Core.Admission{operation, payload, revision, Core.StartReserved{}, Core.Eligible{}}, Core.RequestStart{operation, payload, revision}} : Core.Decision}
  {==}

# ---- foreign_operation_ignored ----
def Laws.foreign_operation_ignored(admission, requested, mismatch):
  match admission:
    case Core.Admission{+operation, +payload, +revision, +phase, +eligibility}:
      %Equal.sym(Bool, Nat.is_eq(operation, requested), False{}, mismatch) : {Core.correlated(_, Core.Admission{operation, payload, revision, phase, eligibility}, Core.AuthorizeStart{requested}) == Core.Decision{Core.Admission{operation, payload, revision, phase, eligibility}, Core.NoCommand{}} : Core.Decision}
      {==}

# ---- initialization_characterized ----
def initial_agrees(equal: Bool, +operation: Nat, +payload: Nat, +revision: Nat) -> {Core.initial(equal, operation, payload, revision) == Spec.initial(equal, operation, payload, revision) : Core.Admission}:
  match equal:
    case True{}:
      {==}
    case False{}:
      {==}

def Laws.initialization_characterized(operation, payload, clock):
  match clock:
    case Core.OriginClock{sourceSequence, currentSourceSequence, +originRevision, currentRevision}:
      initial_agrees(Bool.and(Nat.is_eq(sourceSequence, currentSourceSequence), Nat.is_eq(originRevision, currentRevision)), operation, payload, originRevision)

# ---- recoverable_retry_submits ----
def Laws.recoverable_retry_submits(operation, payload, revision, eligibility):
  %same_operation(operation) : {Core.correlated(_, Core.Admission{operation, payload, revision, Core.Recoverable{}, eligibility}, Core.Submit{operation}) == Core.Decision{Core.Admission{operation, payload, revision, Core.Pending{}, eligibility}, Core.Persist{operation, payload}} : Core.Decision}
  {==}

# ---- superseded_settlement_requested ----
def Laws.superseded_settlement_requested(operation, payload, revision):
  %same_operation(operation) : {Core.correlated(_, Core.Admission{operation, payload, revision, Core.AcceptedWaiting{}, Core.Superseded{}}, Core.PrerequisiteReady{operation}) == Core.Decision{Core.Admission{operation, payload, revision, Core.SupersededReserved{}, Core.Superseded{}}, Core.RecordSuperseded{operation, payload, revision}} : Core.Decision}
  {==}

# ---- eligibility_transition_characterized ----
def eligibility_apply(+admission: Core.Admission, event: Core.AdmissionEvent) -> {Spec.eligibility(Spec.state(Core.apply(admission, event))) == Spec.eligibility(admission) : Core.Eligibility}:
  match admission event:
    case Core.Admission{+operation, +payload, +revision, Core.Reserved{}, Core.Eligible{}} Core.Submit{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Reserved{}, Core.Eligible{}} Core.Accepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Reserved{}, Core.Eligible{}} Core.ExistingAccepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Reserved{}, Core.Eligible{}} Core.AdmissionFailed{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Reserved{}, Core.Eligible{}} Core.AdmissionRejected{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Reserved{}, Core.Eligible{}} Core.PrerequisiteReady{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Reserved{}, Core.Eligible{}} Core.AuthorizeStart{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Reserved{}, Core.Eligible{}} Core.Fence{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Reserved{}, Core.Eligible{}} Core.CaptureClosed{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Reserved{}, Core.Superseded{}} Core.Submit{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Reserved{}, Core.Superseded{}} Core.Accepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Reserved{}, Core.Superseded{}} Core.ExistingAccepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Reserved{}, Core.Superseded{}} Core.AdmissionFailed{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Reserved{}, Core.Superseded{}} Core.AdmissionRejected{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Reserved{}, Core.Superseded{}} Core.PrerequisiteReady{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Reserved{}, Core.Superseded{}} Core.AuthorizeStart{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Reserved{}, Core.Superseded{}} Core.Fence{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Reserved{}, Core.Superseded{}} Core.CaptureClosed{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Pending{}, Core.Eligible{}} Core.Submit{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Pending{}, Core.Eligible{}} Core.Accepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Pending{}, Core.Eligible{}} Core.ExistingAccepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Pending{}, Core.Eligible{}} Core.AdmissionFailed{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Pending{}, Core.Eligible{}} Core.AdmissionRejected{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Pending{}, Core.Eligible{}} Core.PrerequisiteReady{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Pending{}, Core.Eligible{}} Core.AuthorizeStart{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Pending{}, Core.Eligible{}} Core.Fence{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Pending{}, Core.Eligible{}} Core.CaptureClosed{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Pending{}, Core.Superseded{}} Core.Submit{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Pending{}, Core.Superseded{}} Core.Accepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Pending{}, Core.Superseded{}} Core.ExistingAccepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Pending{}, Core.Superseded{}} Core.AdmissionFailed{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Pending{}, Core.Superseded{}} Core.AdmissionRejected{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Pending{}, Core.Superseded{}} Core.PrerequisiteReady{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Pending{}, Core.Superseded{}} Core.AuthorizeStart{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Pending{}, Core.Superseded{}} Core.Fence{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Pending{}, Core.Superseded{}} Core.CaptureClosed{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedWaiting{}, Core.Eligible{}} Core.Submit{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedWaiting{}, Core.Eligible{}} Core.Accepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedWaiting{}, Core.Eligible{}} Core.ExistingAccepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedWaiting{}, Core.Eligible{}} Core.AdmissionFailed{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedWaiting{}, Core.Eligible{}} Core.AdmissionRejected{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedWaiting{}, Core.Eligible{}} Core.PrerequisiteReady{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedWaiting{}, Core.Eligible{}} Core.AuthorizeStart{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedWaiting{}, Core.Eligible{}} Core.Fence{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedWaiting{}, Core.Eligible{}} Core.CaptureClosed{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedWaiting{}, Core.Superseded{}} Core.Submit{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedWaiting{}, Core.Superseded{}} Core.Accepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedWaiting{}, Core.Superseded{}} Core.ExistingAccepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedWaiting{}, Core.Superseded{}} Core.AdmissionFailed{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedWaiting{}, Core.Superseded{}} Core.AdmissionRejected{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedWaiting{}, Core.Superseded{}} Core.PrerequisiteReady{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedWaiting{}, Core.Superseded{}} Core.AuthorizeStart{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedWaiting{}, Core.Superseded{}} Core.Fence{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedWaiting{}, Core.Superseded{}} Core.CaptureClosed{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.StartReserved{}, Core.Eligible{}} Core.Submit{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.StartReserved{}, Core.Eligible{}} Core.Accepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.StartReserved{}, Core.Eligible{}} Core.ExistingAccepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.StartReserved{}, Core.Eligible{}} Core.AdmissionFailed{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.StartReserved{}, Core.Eligible{}} Core.AdmissionRejected{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.StartReserved{}, Core.Eligible{}} Core.PrerequisiteReady{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.StartReserved{}, Core.Eligible{}} Core.AuthorizeStart{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.StartReserved{}, Core.Eligible{}} Core.Fence{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.StartReserved{}, Core.Eligible{}} Core.CaptureClosed{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.StartReserved{}, Core.Superseded{}} Core.Submit{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.StartReserved{}, Core.Superseded{}} Core.Accepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.StartReserved{}, Core.Superseded{}} Core.ExistingAccepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.StartReserved{}, Core.Superseded{}} Core.AdmissionFailed{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.StartReserved{}, Core.Superseded{}} Core.AdmissionRejected{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.StartReserved{}, Core.Superseded{}} Core.PrerequisiteReady{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.StartReserved{}, Core.Superseded{}} Core.AuthorizeStart{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.StartReserved{}, Core.Superseded{}} Core.Fence{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.StartReserved{}, Core.Superseded{}} Core.CaptureClosed{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.SupersededReserved{}, Core.Eligible{}} Core.Submit{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.SupersededReserved{}, Core.Eligible{}} Core.Accepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.SupersededReserved{}, Core.Eligible{}} Core.ExistingAccepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.SupersededReserved{}, Core.Eligible{}} Core.AdmissionFailed{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.SupersededReserved{}, Core.Eligible{}} Core.AdmissionRejected{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.SupersededReserved{}, Core.Eligible{}} Core.PrerequisiteReady{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.SupersededReserved{}, Core.Eligible{}} Core.AuthorizeStart{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.SupersededReserved{}, Core.Eligible{}} Core.Fence{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.SupersededReserved{}, Core.Eligible{}} Core.CaptureClosed{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.SupersededReserved{}, Core.Superseded{}} Core.Submit{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.SupersededReserved{}, Core.Superseded{}} Core.Accepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.SupersededReserved{}, Core.Superseded{}} Core.ExistingAccepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.SupersededReserved{}, Core.Superseded{}} Core.AdmissionFailed{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.SupersededReserved{}, Core.Superseded{}} Core.AdmissionRejected{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.SupersededReserved{}, Core.Superseded{}} Core.PrerequisiteReady{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.SupersededReserved{}, Core.Superseded{}} Core.AuthorizeStart{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.SupersededReserved{}, Core.Superseded{}} Core.Fence{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.SupersededReserved{}, Core.Superseded{}} Core.CaptureClosed{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Started{}, Core.Eligible{}} Core.Submit{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Started{}, Core.Eligible{}} Core.Accepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Started{}, Core.Eligible{}} Core.ExistingAccepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Started{}, Core.Eligible{}} Core.AdmissionFailed{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Started{}, Core.Eligible{}} Core.AdmissionRejected{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Started{}, Core.Eligible{}} Core.PrerequisiteReady{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Started{}, Core.Eligible{}} Core.AuthorizeStart{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Started{}, Core.Eligible{}} Core.Fence{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Started{}, Core.Eligible{}} Core.CaptureClosed{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Started{}, Core.Superseded{}} Core.Submit{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Started{}, Core.Superseded{}} Core.Accepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Started{}, Core.Superseded{}} Core.ExistingAccepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Started{}, Core.Superseded{}} Core.AdmissionFailed{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Started{}, Core.Superseded{}} Core.AdmissionRejected{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Started{}, Core.Superseded{}} Core.PrerequisiteReady{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Started{}, Core.Superseded{}} Core.AuthorizeStart{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Started{}, Core.Superseded{}} Core.Fence{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Started{}, Core.Superseded{}} Core.CaptureClosed{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedExisting{}, Core.Eligible{}} Core.Submit{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedExisting{}, Core.Eligible{}} Core.Accepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedExisting{}, Core.Eligible{}} Core.ExistingAccepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedExisting{}, Core.Eligible{}} Core.AdmissionFailed{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedExisting{}, Core.Eligible{}} Core.AdmissionRejected{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedExisting{}, Core.Eligible{}} Core.PrerequisiteReady{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedExisting{}, Core.Eligible{}} Core.AuthorizeStart{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedExisting{}, Core.Eligible{}} Core.Fence{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedExisting{}, Core.Eligible{}} Core.CaptureClosed{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedExisting{}, Core.Superseded{}} Core.Submit{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedExisting{}, Core.Superseded{}} Core.Accepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedExisting{}, Core.Superseded{}} Core.ExistingAccepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedExisting{}, Core.Superseded{}} Core.AdmissionFailed{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedExisting{}, Core.Superseded{}} Core.AdmissionRejected{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedExisting{}, Core.Superseded{}} Core.PrerequisiteReady{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedExisting{}, Core.Superseded{}} Core.AuthorizeStart{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedExisting{}, Core.Superseded{}} Core.Fence{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedExisting{}, Core.Superseded{}} Core.CaptureClosed{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Recoverable{}, Core.Eligible{}} Core.Submit{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Recoverable{}, Core.Eligible{}} Core.Accepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Recoverable{}, Core.Eligible{}} Core.ExistingAccepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Recoverable{}, Core.Eligible{}} Core.AdmissionFailed{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Recoverable{}, Core.Eligible{}} Core.AdmissionRejected{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Recoverable{}, Core.Eligible{}} Core.PrerequisiteReady{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Recoverable{}, Core.Eligible{}} Core.AuthorizeStart{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Recoverable{}, Core.Eligible{}} Core.Fence{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Recoverable{}, Core.Eligible{}} Core.CaptureClosed{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Recoverable{}, Core.Superseded{}} Core.Submit{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Recoverable{}, Core.Superseded{}} Core.Accepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Recoverable{}, Core.Superseded{}} Core.ExistingAccepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Recoverable{}, Core.Superseded{}} Core.AdmissionFailed{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Recoverable{}, Core.Superseded{}} Core.AdmissionRejected{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Recoverable{}, Core.Superseded{}} Core.PrerequisiteReady{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Recoverable{}, Core.Superseded{}} Core.AuthorizeStart{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Recoverable{}, Core.Superseded{}} Core.Fence{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Recoverable{}, Core.Superseded{}} Core.CaptureClosed{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Rejected{}, Core.Eligible{}} Core.Submit{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Rejected{}, Core.Eligible{}} Core.Accepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Rejected{}, Core.Eligible{}} Core.ExistingAccepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Rejected{}, Core.Eligible{}} Core.AdmissionFailed{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Rejected{}, Core.Eligible{}} Core.AdmissionRejected{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Rejected{}, Core.Eligible{}} Core.PrerequisiteReady{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Rejected{}, Core.Eligible{}} Core.AuthorizeStart{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Rejected{}, Core.Eligible{}} Core.Fence{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Rejected{}, Core.Eligible{}} Core.CaptureClosed{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Rejected{}, Core.Superseded{}} Core.Submit{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Rejected{}, Core.Superseded{}} Core.Accepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Rejected{}, Core.Superseded{}} Core.ExistingAccepted{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Rejected{}, Core.Superseded{}} Core.AdmissionFailed{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Rejected{}, Core.Superseded{}} Core.AdmissionRejected{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Rejected{}, Core.Superseded{}} Core.PrerequisiteReady{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Rejected{}, Core.Superseded{}} Core.AuthorizeStart{_}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Rejected{}, Core.Superseded{}} Core.Fence{}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Rejected{}, Core.Superseded{}} Core.CaptureClosed{}:
      {==}

def eligibility_fence(admission: Core.Admission) -> {Spec.eligibility(Spec.state(Core.fence(admission))) == Core.Superseded{} : Core.Eligibility}:
  match admission:
    case Core.Admission{+operation, +payload, +revision, Core.Reserved{}, Core.Eligible{}}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Reserved{}, Core.Superseded{}}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Pending{}, Core.Eligible{}}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Pending{}, Core.Superseded{}}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedWaiting{}, Core.Eligible{}}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedWaiting{}, Core.Superseded{}}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.StartReserved{}, Core.Eligible{}}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.StartReserved{}, Core.Superseded{}}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.SupersededReserved{}, Core.Eligible{}}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.SupersededReserved{}, Core.Superseded{}}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Started{}, Core.Eligible{}}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Started{}, Core.Superseded{}}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedExisting{}, Core.Eligible{}}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.AcceptedExisting{}, Core.Superseded{}}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Recoverable{}, Core.Eligible{}}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Recoverable{}, Core.Superseded{}}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Rejected{}, Core.Eligible{}}:
      {==}
    case Core.Admission{+operation, +payload, +revision, Core.Rejected{}, Core.Superseded{}}:
      {==}

def eligibility_correlated(matches: Bool, +admission: Core.Admission, event: Core.AdmissionEvent) -> {Spec.eligibility(Spec.state(Core.correlated(matches, admission, event))) == Spec.eligibility(admission) : Core.Eligibility}:
  match matches:
    case True{}:
      eligibility_apply(admission, event)
    case False{}:
      {==}

def Laws.eligibility_transition_characterized(admission, event):
  match event:
    case Core.Submit{+requested}:
      eligibility_correlated(Nat.is_eq(Core.operation(admission), requested), admission, Core.Submit{requested})
    case Core.Accepted{+requested}:
      eligibility_correlated(Nat.is_eq(Core.operation(admission), requested), admission, Core.Accepted{requested})
    case Core.ExistingAccepted{+requested}:
      eligibility_correlated(Nat.is_eq(Core.operation(admission), requested), admission, Core.ExistingAccepted{requested})
    case Core.AdmissionFailed{+requested}:
      eligibility_correlated(Nat.is_eq(Core.operation(admission), requested), admission, Core.AdmissionFailed{requested})
    case Core.AdmissionRejected{+requested}:
      eligibility_correlated(Nat.is_eq(Core.operation(admission), requested), admission, Core.AdmissionRejected{requested})
    case Core.PrerequisiteReady{+requested}:
      eligibility_correlated(Nat.is_eq(Core.operation(admission), requested), admission, Core.PrerequisiteReady{requested})
    case Core.AuthorizeStart{+requested}:
      eligibility_correlated(Nat.is_eq(Core.operation(admission), requested), admission, Core.AuthorizeStart{requested})
    case Core.Fence{}:
      eligibility_fence(admission)
    case Core.CaptureClosed{}:
      {==}
