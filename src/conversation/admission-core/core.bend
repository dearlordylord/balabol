import Base

type Phase is Data:
  Reserved{}
  Pending{}
  AcceptedWaiting{}
  StartReserved{}
  SupersededReserved{}
  Started{}
  AcceptedExisting{}
  Recoverable{}
  Rejected{}

type Eligibility is Data:
  Eligible{}
  Superseded{}

type OriginClock is Data:
  OriginClock{sourceSequence: Nat, currentSourceSequence: Nat, originRevision: Nat, currentRevision: Nat}

type Admission is Data:
  Admission{operation: Nat, payload: Nat, revision: Nat, phase: Phase, eligibility: Eligibility}

type AdmissionEvent is Data:
  Submit{operation: Nat}
  Accepted{operation: Nat}
  ExistingAccepted{operation: Nat}
  AdmissionFailed{operation: Nat}
  AdmissionRejected{operation: Nat}
  PrerequisiteReady{operation: Nat}
  AuthorizeStart{operation: Nat}
  Fence{}
  CaptureClosed{}

type Command is Data:
  NoCommand{}
  Persist{operation: Nat, payload: Nat}
  AcknowledgeReceipt{operation: Nat, payload: Nat}
  RequestStart{operation: Nat, payload: Nat, revision: Nat}
  StartResponse{operation: Nat, payload: Nat, revision: Nat}
  RecordSuperseded{operation: Nat, payload: Nat, revision: Nat}
  RevokeStart{operation: Nat}
  ReportFailure{operation: Nat}

type Decision is Data:
  Decision{state: Admission, command: Command}

def operation(state: Admission) -> Nat:
  match state:
    case Admission{operation, _, _, _, _}:
      operation

def unchanged(state: Admission) -> Decision:
  Decision{state, NoCommand{}}

def initial(eligible: Bool, operation: Nat, payload: Nat, revision: Nat) -> Admission:
  match eligible:
    case True{}:
      Admission{operation, payload, revision, Reserved{}, Eligible{}}
    case False{}:
      Admission{operation, payload, revision, Reserved{}, Superseded{}}

def initialize(operation: Nat, payload: Nat, clock: OriginClock) -> Admission:
  match clock:
    case OriginClock{sourceSequence, currentSourceSequence, +originRevision, currentRevision}:
      initial(Bool.and(Nat.is_eq(sourceSequence, currentSourceSequence), Nat.is_eq(originRevision, currentRevision)), operation, payload, originRevision)

def apply(state: Admission, event: AdmissionEvent) -> Decision:
  match state event:
    case Admission{+operation, +payload, revision, Reserved{}, eligibility} Submit{_}:
      Decision{Admission{operation, payload, revision, Pending{}, eligibility}, Persist{operation, payload}}
    case Admission{+operation, +payload, revision, Recoverable{}, eligibility} Submit{_}:
      Decision{Admission{operation, payload, revision, Pending{}, eligibility}, Persist{operation, payload}}
    case Admission{+operation, +payload, revision, Pending{}, eligibility} Accepted{_}:
      Decision{Admission{operation, payload, revision, AcceptedWaiting{}, eligibility}, AcknowledgeReceipt{operation, payload}}
    case Admission{+operation, +payload, revision, Pending{}, eligibility} ExistingAccepted{_}:
      Decision{Admission{operation, payload, revision, AcceptedExisting{}, eligibility}, AcknowledgeReceipt{operation, payload}}
    case Admission{+operation, payload, revision, Reserved{}, eligibility} AdmissionFailed{_}:
      Decision{Admission{operation, payload, revision, Recoverable{}, eligibility}, ReportFailure{operation}}
    case Admission{+operation, payload, revision, Pending{}, eligibility} AdmissionFailed{_}:
      Decision{Admission{operation, payload, revision, Recoverable{}, eligibility}, ReportFailure{operation}}
    case Admission{+operation, payload, revision, Reserved{}, eligibility} AdmissionRejected{_}:
      Decision{Admission{operation, payload, revision, Rejected{}, eligibility}, ReportFailure{operation}}
    case Admission{+operation, payload, revision, Pending{}, eligibility} AdmissionRejected{_}:
      Decision{Admission{operation, payload, revision, Rejected{}, eligibility}, ReportFailure{operation}}
    case Admission{+operation, payload, revision, Recoverable{}, eligibility} AdmissionRejected{_}:
      Decision{Admission{operation, payload, revision, Rejected{}, eligibility}, ReportFailure{operation}}
    case Admission{+operation, +payload, +revision, AcceptedWaiting{}, Eligible{}} PrerequisiteReady{_}:
      Decision{Admission{operation, payload, revision, StartReserved{}, Eligible{}}, RequestStart{operation, payload, revision}}
    case Admission{+operation, +payload, +revision, StartReserved{}, Eligible{}} AuthorizeStart{_}:
      Decision{Admission{operation, payload, revision, Started{}, Eligible{}}, StartResponse{operation, payload, revision}}
    case Admission{+operation, +payload, +revision, AcceptedWaiting{}, Superseded{}} PrerequisiteReady{_}:
      Decision{Admission{operation, payload, revision, SupersededReserved{}, Superseded{}}, RecordSuperseded{operation, payload, revision}}
    case Admission{+operation, +payload, +revision, StartReserved{}, Superseded{}} AuthorizeStart{_}:
      Decision{Admission{operation, payload, revision, SupersededReserved{}, Superseded{}}, RecordSuperseded{operation, payload, revision}}
    case state _:
      unchanged(state)

def correlated(matches: Bool, state: Admission, event: AdmissionEvent) -> Decision:
  match matches:
    case True{}:
      apply(state, event)
    case False{}:
      unchanged(state)

def fence(state: Admission) -> Decision:
  match state:
    case Admission{+operation, payload, revision, StartReserved{}, Eligible{}}:
      Decision{Admission{operation, payload, revision, StartReserved{}, Superseded{}}, RevokeStart{operation}}
    case Admission{+operation, payload, revision, Started{}, Eligible{}}:
      Decision{Admission{operation, payload, revision, Started{}, Superseded{}}, RevokeStart{operation}}
    case Admission{operation, payload, revision, phase, _}:
      Decision{Admission{operation, payload, revision, phase, Superseded{}}, NoCommand{}}

def transition(+state: Admission, event: AdmissionEvent) -> Decision:
  match event:
    case Submit{+requested}:
      correlated(Nat.is_eq(operation(state), requested), state, Submit{requested})
    case Accepted{+requested}:
      correlated(Nat.is_eq(operation(state), requested), state, Accepted{requested})
    case ExistingAccepted{+requested}:
      correlated(Nat.is_eq(operation(state), requested), state, ExistingAccepted{requested})
    case AdmissionFailed{+requested}:
      correlated(Nat.is_eq(operation(state), requested), state, AdmissionFailed{requested})
    case AdmissionRejected{+requested}:
      correlated(Nat.is_eq(operation(state), requested), state, AdmissionRejected{requested})
    case PrerequisiteReady{+requested}:
      correlated(Nat.is_eq(operation(state), requested), state, PrerequisiteReady{requested})
    case AuthorizeStart{+requested}:
      correlated(Nat.is_eq(operation(state), requested), state, AuthorizeStart{requested})
    case Fence{}:
      fence(state)
    case CaptureClosed{}:
      unchanged(state)
