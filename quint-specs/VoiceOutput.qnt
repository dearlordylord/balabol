/// One MainActor-owned output projection. Events are delivered sequentially;
/// Network loss is composed separately; capture scheduling and physical audio
/// are outside this model. Cut is an already-authorized interruption, not proof
/// that a microphone onset came from the human rather than assistant echo.
module VoiceOutputCore {
  import basicSpells.* from "./spells/basicSpells"
  type Identity = { input: int, response: int, epoch: int }
  type Status = Preparing | AwaitingReady | Playing | Delivered | Interrupted | Failed
  type Output = { identity: Identity, status: Status, manifest: bool, session: int }
  type State = {
    current: Option[Output], locallyInterrupted: bool, unavailable: bool,
    receivedAudio: bool, closed: bool, sequence: int,
    lastAcceptedInput: Option[int], cutInput: Option[int], cutAcceptedInput: Option[int],
    cutPendingInputs: List[int], allowedInput: Option[int], gated: bool,
    prepared: Option[Identity], interrupted: Option[Identity]
  }
  type Event = Observe({ sequence: int, output: Output }) | Accept(int)
    | Audio(Identity) | Cut({ nextInput: Option[int], pending: List[int] })
    | Fail(Identity) | Disconnect
  type Command = Prepare(Output) | Suppress({ target: Option[Identity], stopLocal: bool })
  type Result = { state: State, commands: List[Command] }
  pure val initial: State = { current: None, locallyInterrupted: false, unavailable: false,
    receivedAudio: false, closed: false, sequence: -1, lastAcceptedInput: None,
    cutInput: None, cutAcceptedInput: None, cutPendingInputs: List(), allowedInput: None,
    gated: false, prepared: None, interrupted: None }
  pure def active(status: Status): bool = Set(Preparing, AwaitingReady, Playing).contains(status)
  pure def identity(current: Option[Output]): Option[Identity] = match current {
    | Some(value) => Some(value.identity) | None => None
  }
  pure val X: Identity = {input: 1, response: 1, epoch: 1}
  pure val Y: Identity = {input: 2, response: 2, epoch: 1}
  pure val Z: Identity = {input: 1, response: 1, epoch: 2}
  pure val IDENTITIES = Set(X, Y, Z, {input: 1, response: 2, epoch: 1})
  pure def value(id: Identity, status: Status): Output = {identity: id, status: status,
    manifest: Set(AwaitingReady, Playing, Delivered).contains(status), session: 1}
  pure def manifestValue(v: Output): Output = {...v, status: AwaitingReady, manifest: true}
  pure def valid(v: Output): bool = v.identity.input > 0 and v.identity.response > 0 and v.identity.epoch > 0
    and (if (v.status == Preparing) not(v.manifest)
      else if (Set(AwaitingReady, Playing, Delivered).contains(v.status)) v.manifest else true)
  pure def suppressTarget(c: Command): Option[Identity] = match c { | Suppress(v) => v.target | _ => None }
  pure def suppressLocal(c: Command): bool = match c { | Suppress(v) => v.stopLocal | _ => false }
  pure def isSuppress(c: Command): bool = match c { | Suppress(_) => true | _ => false }
  pure def unchanged(s: State): Result = { state: s, commands: List() }
  pure def suppress(s: State, target: Option[Identity], stop: bool): Result =
    { state: s, commands: List(Suppress({target: target, stopLocal: stop})) }
  pure def reject(s: State, v: Output): Result = {
    val selected = if (s.current == None) { ...s, current: Some(v),
      locallyInterrupted: active(v.status) or v.status == Interrupted, unavailable: v.status == Failed } else s
    if (active(v.status) and Some(v.identity) != s.interrupted)
      suppress({...selected, interrupted: Some(v.identity)}, Some(v.identity), false)
    else unchanged(selected)
  }
  pure def regresses(current: Option[Output], v: Output): bool = match current {
    | None => false
    | Some(old) => old.identity == v.identity and (not(active(old.status)) or
      (old.status == Playing and Set(Preparing, AwaitingReady).contains(v.status)))
  }
  pure def observe(s: State, seq: int, v: Output): Result = {
    val advanced = {...s, sequence: seq}
    val terminalEvidence = identity(s.current) == Some(v.identity) and not(active(v.status))
    if (s.closed or seq <= s.sequence) unchanged(s)
    else if (s.gated and Some(v.identity.input) != s.allowedInput and not(terminalEvidence)) reject(advanced, v)
    else if (regresses(s.current, v)) unchanged(advanced)
    else {
      val selected = {...advanced, current: Some(v),
        locallyInterrupted: v.status == Interrupted or (s.locallyInterrupted and v.status == Delivered),
        unavailable: v.status == Failed,
        receivedAudio: if (identity(s.current) == Some(v.identity)) s.receivedAudio else false}
      if (v.status == Delivered) unchanged({...selected, prepared: None})
      else if (Set(Interrupted, Failed).contains(v.status)) suppress({...selected, prepared: None}, None, true)
      else if (not(v.manifest) or selected.prepared == Some(v.identity)) unchanged(selected)
      else {state: {...selected, prepared: Some(v.identity)}, commands: List(Prepare(manifestValue(v)))}
    }
  }
  pure def apply(s: State, e: Event): Result = match e {
    | Observe(v) => observe(s, v.sequence, v.output)
    | Accept(id) => {
      val allow = s.gated and Some(id) != s.cutInput and Some(id) != s.cutAcceptedInput and not(s.cutPendingInputs.foldl(false, (found, v) => found or v == id))
      unchanged({...s, lastAcceptedInput: Some(id), allowedInput: if (allow) Some(id) else s.allowedInput})
    }
    | Audio(id) => if (s.prepared == Some(id) and identity(s.current) == Some(id) and not(s.locallyInterrupted))
        unchanged({...s, receivedAudio: true}) else unchanged(s)
    | Cut(v) => {
      val target = match s.current { | Some(value) => if (active(value.status)) Some(value.identity) else None | None => None }
      val input = match s.current { | Some(value) => Some(value.identity.input) | None => None }
      suppress({...s, locallyInterrupted: s.locallyInterrupted or target != None, cutInput: input,
        cutAcceptedInput: s.lastAcceptedInput, cutPendingInputs: v.pending.slice(0, if (v.pending.length() > 2) 2 else v.pending.length()),
        allowedInput: v.nextInput, gated: true, prepared: None, interrupted: target},
        if (target == s.interrupted) None else target, true)
    }
    | Fail(id) => if (identity(s.current) == Some(id)) suppress({...s, unavailable: true, prepared: None}, None, true) else unchanged(s)
    | Disconnect => suppress({...s, current: None, locallyInterrupted: false, unavailable: false,
        receivedAudio: false, closed: true, prepared: None}, None, true)
  }
}
module VoiceOutputMachine {
  const oldGate: bool
  const reactivate: bool
  import basicSpells.* from "./spells/basicSpells"
  import VoiceOutputCore.*
  var state: State
  var previous: State
  var event: Option[Event]
  var commands: List[Command]
  action init = all { state' = initial, previous' = initial, event' = None, commands' = List() }
  action deliver(e: Event): bool = {
    val normal = apply(state, e)
    val result = match e {
      | Observe(v) => if (oldGate and not(state.closed) and v.sequence > state.sequence and state.gated and Some(v.output.identity.input) != state.allowedInput)
          reject({...state, sequence: v.sequence}, v.output)
        else if (reactivate and not(state.closed) and v.sequence > state.sequence and identity(state.current) == Some(v.output.identity) and active(v.output.status))
          {state: {...normal.state, current: Some(v.output)}, commands: normal.commands}
        else normal
      | _ => normal
    }
    all {previous' = state, state' = result.state, event' = Some(e), commands' = result.commands}
  }
  action observeEvent(seq: int, v: Output): bool = all { valid(v), deliver(Observe({sequence: seq, output: v})) }
  action selectedAudio = match state.prepared {
    | Some(selected) => deliver(Audio(selected))
    | None => all {false, deliver(Audio(X))}
  }
  action step = {
    nondet id = IDENTITIES.oneOf()
    nondet status = Set(Preparing, AwaitingReady, Playing, Delivered, Interrupted, Failed).oneOf()
    nondet seq = Set(0, 1, 2, 3).oneOf()
    nondet input = Set(1, 2).oneOf()
    nondet allowed = Set(None, Some(1), Some(2)).oneOf()
    any { observeEvent(seq, value(id, status)), deliver(Accept(input)), deliver(Audio(id)),
      deliver(Cut({nextInput: allowed, pending: List()})), deliver(Fail(id)), deliver(Disconnect), selectedAudio }
  }
  val reachedObservation = match event { | Some(e) => match e { | Observe(_) => true | _ => false } | None => false }
  val reachedAcceptance = match event { | Some(e) => match e { | Accept(_) => true | _ => false } | None => false }
  val reachedAudio = match event { | Some(e) => match e { | Audio(_) => state.receivedAudio | _ => false } | None => false }
  val reachedCut = match event { | Some(e) => match e { | Cut(_) => state.gated and commands.length() > 0 | _ => false } | None => false }
  val reachedFailure = match event { | Some(e) => match e { | Fail(_) => state.unavailable and commands.length() > 0 | _ => false } | None => false }
  val reachedDisconnect = match event { | Some(e) => match e { | Disconnect => state.closed and commands.length() > 0 | _ => false } | None => false }
  val reachedPreparation = commands.foldl(false, (found, c) => found or (match c { | Prepare(_) => true | _ => false }))
  // Immediate evidence admission is safety, not eventual network delivery.
  val terminalEvidenceAdmitted = match event {
    | Some(e) => match e {
      | Observe(v) => (not(previous.closed) and v.sequence > previous.sequence and
          identity(previous.current) == Some(v.output.identity) and
          not(active(v.output.status)) and
          (match previous.current { | Some(old) => active(old.status) | None => false }))
        implies (state.current == Some(v.output) and state.prepared == None and
          not(commands.foldl(false, (found, c) => found or (match c { | Prepare(_) => true | _ => false }))))
      | _ => true
    }
    | None => true
  }
  val noTerminalReactivation = match event {
    | Some(e) => match e {
      | Observe(v) => (not(previous.closed) and v.sequence > previous.sequence and
          identity(previous.current) == Some(v.output.identity) and
          (match previous.current { | Some(old) => not(active(old.status)) | None => false }))
        implies (state.current == previous.current)
      | _ => true
    }
    | None => true
  }
  val authorizedPreparation = commands.foldl(true, (ok, c) => ok and (match c {
    | Prepare(v) => state.prepared == Some(v.identity) and identity(state.current) == Some(v.identity) and
        not(state.locallyInterrupted) and (not(state.gated) or state.allowedInput == Some(v.identity.input))
    | _ => true
  }))
  val rejectedIdentityCannotBorrowEvidence = match event {
    | Some(e) => match e {
      | Observe(v) => (not(previous.closed) and v.sequence > previous.sequence and previous.gated
          and previous.allowedInput != Some(v.output.identity.input) and previous.current != None
          and identity(previous.current) != Some(v.output.identity))
        implies (state.current == previous.current and commands.foldl(true, (ok, c) => ok and (match c { | Prepare(_) => false | _ => true })))
      | _ => true
    }
    | None => true
  }
  val safety = terminalEvidenceAdmitted and noTerminalReactivation and authorizedPreparation and rejectedIdentityCannotBorrowEvidence
}

module VoiceOutput {
  import VoiceOutputMachine(oldGate = false, reactivate = false).* 
}
module VoiceOutputGateMutant {
  import basicSpells.* from "./spells/basicSpells"
  import VoiceOutputCore.*
  import VoiceOutputMachine(oldGate = true, reactivate = false).*
  action deterministicMutantStep = if (event == None) observeEvent(0, value(X, Playing))
    else if (not(state.gated)) deliver(Cut({nextInput: None, pending: List()}))
    else observeEvent(1, value(X, Interrupted))
}
module VoiceOutputReactivationMutant {
  import basicSpells.* from "./spells/basicSpells"
  import VoiceOutputCore.*
  import VoiceOutputMachine(oldGate = false, reactivate = true).*
  action deterministicMutantStep = if (event == None) observeEvent(0, value(X, Playing))
    else if (state.sequence == 0) observeEvent(1, value(X, Delivered))
    else observeEvent(2, value(X, Playing))
}

/// Deliberately small finite checker instance. Other identity/event dimensions
/// are exercised by deterministic replay and sampling, not this state space.
module VoiceOutputFinite {
  import basicSpells.* from "./spells/basicSpells"
  import VoiceOutputCore.*
  import VoiceOutputMachine(oldGate = false, reactivate = false).*
  action finiteStep = {
    nondet status = Set(Preparing, AwaitingReady, Playing, Delivered, Interrupted, Failed).oneOf()
    nondet seq = Set(0, 1).oneOf()
    nondet allowed = Set(None, Some(2)).oneOf()
    any { observeEvent(seq, value(X, status)), deliver(Cut({nextInput: allowed, pending: List()})) }
  }
}
