import Base
import ./core.bend as Core

# These independent projections/specification constructors do not call decisions.
type Intent is Data:
  Intent{operation: Nat, payload: Nat, revision: Nat}

def intent(state: Core.Admission) -> Intent:
  match state:
    case Core.Admission{operation, payload, revision, _, _}:
      Intent{operation, payload, revision}

def operation(state: Core.Admission) -> Nat:
  match state:
    case Core.Admission{operation, _, _, _, _}:
      operation

def state(decision: Core.Decision) -> Core.Admission:
  match decision:
    case Core.Decision{state, _}:
      state

def command(decision: Core.Decision) -> Core.Command:
  match decision:
    case Core.Decision{_, command}:
      command

def starts(command: Core.Command) -> Bool:
  match command:
    case Core.StartResponse{_, _, _}:
      True{}
    case _:
      False{}

def initial(equal: Bool, operation: Nat, payload: Nat, revision: Nat) -> Core.Admission:
  match equal:
    case True{}:
      Core.Admission{operation, payload, revision, Core.Reserved{}, Core.Eligible{}}
    case False{}:
      Core.Admission{operation, payload, revision, Core.Reserved{}, Core.Superseded{}}

def initialize(operation: Nat, payload: Nat, clock: Core.OriginClock) -> Core.Admission:
  match clock:
    case Core.OriginClock{sourceSequence, currentSourceSequence, +originRevision, currentRevision}:
      initial(Bool.and(Nat.is_eq(sourceSequence, currentSourceSequence), Nat.is_eq(originRevision, currentRevision)), operation, payload, originRevision)

def eligibility(state: Core.Admission) -> Core.Eligibility:
  match state:
    case Core.Admission{_, _, _, _, eligibility}:
      eligibility

def expected_eligibility(state: Core.Admission, event: Core.AdmissionEvent) -> Core.Eligibility:
  match event:
    case Core.Fence{}:
      Core.Superseded{}
    case _:
      eligibility(state)
