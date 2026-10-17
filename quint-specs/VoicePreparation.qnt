/// Narrow preparation boundary. Context facts are supplied by the owner;
/// this does not model the capture lifecycle that establishes those facts.
module VoicePreparationCore {
  import basicSpells.* from "./spells/basicSpells"
  import VoiceOutputCore as O from "./VoiceOutput"
  type Capture = Listening | Muted | Paused
  type Origin = { session: int, incarnation: int }
  type Request = { generation: int, id: int }
  type Kind = PrepareWork(O::Output) | ReadyWork({ origin: Origin, output: O::Output })
    | StopWork({ target: Option[O::Identity], session: Option[int] })
    | InterruptWork({ origin: Origin, target: O::Identity })
  type Operation = { request: Request, kind: Kind, cancelling: bool }
  type State = { output: O::State, generation: int, retired: bool, capture: Capture,
    origin: Option[Origin], operations: List[Operation], nextRequest: int,
    preparedOutput: Option[O::Identity], localStop: Option[Request] }
  type WorkResult = Succeeded | WorkFailed | Cancelled
  type Event = Project(O::Event) | Progress | Complete({request: Request, result: WorkResult})
    | Context({ generation: int, retired: bool, capture: Capture, origin: Option[Origin] })
  type Command = Run({request: Request, kind: Kind, after: List[Request]}) | CancelWork(List[Request])
  type Result = {state: State, commands: List[Command]}
  pure val initial: State = {output: O::initial, generation: 1, retired: false,
    capture: Listening, origin: Some({session: 1, incarnation: 1}), operations: List(),
    nextRequest: 1, preparedOutput: None, localStop: None}
  pure def unchanged(s: State): Result = {state: s, commands: List()}
  pure def reserve(s: State, kind: Kind, after: List[Request]): Result = {
    val req = {generation: s.generation, id: s.nextRequest}
    {state: {...s, nextRequest: s.nextRequest + 1,
      operations: s.operations.append({request: req, kind: kind, cancelling: false})},
     commands: List(Run({request: req, kind: kind, after: after}))}
  }
  pure def isStop(kind: Kind): bool = match kind { | StopWork(_) => true | _ => false }
  pure def isPrepare(kind: Kind): bool = match kind { | PrepareWork(_) => true | _ => false }
  pure def outputWork(kind: Kind): bool = match kind { | PrepareWork(_) => true | ReadyWork(_) => true | _ => false }
  pure def session(s: State): Option[int] = match s.origin { | Some(o) => Some(o.session) | None => None }
  pure def ensureStop(s: State): Result = {
    val stops = s.operations.select(op => isStop(op.kind))
    if (stops.length() > 0) unchanged({...s, localStop: Some(stops.nth(stops.length() - 1).request)})
    else {
      val stopped = reserve(s, StopWork({target: O::identity(s.output.current), session: session(s)}), List())
      {state: {...stopped.state, localStop: Some({generation: s.generation, id: s.nextRequest})}, commands: stopped.commands}
    }
  }
  pure def suppress(s: State, target: Option[O::Identity], stopLocal: bool): Result = {
    val requests = s.operations.select(op => not(op.cancelling) and outputWork(op.kind)).foldl(List(), (acc, op) => acc.append(op.request))
    val cancelled = if (stopLocal) {...s, operations: s.operations.foldl(List(), (acc, op) =>
      acc.append(if (outputWork(op.kind)) {...op, cancelling: true} else op))} else s
    val stopped = if (stopLocal) ensureStop(cancelled) else unchanged(s)
    val cancelledCommands = if (stopLocal and requests.length() > 0) List(CancelWork(requests)) else List()
    val result = match target {
      | None => stopped
      | Some(id) => match s.origin {
        | None => stopped
        | Some(origin) => {
          val after = if (stopLocal) match stopped.state.localStop { | Some(req) => List(req) | None => List() } else List()
          val requested = reserve(stopped.state, InterruptWork({origin: origin, target: id}), after)
          {state: requested.state, commands: stopped.commands.concat(requested.commands)}
        }
      }
    }
    {state: result.state, commands: cancelledCommands.concat(result.commands)}
  }
  pure def project(s: State, e: O::Event): Result = {
    val projected = O::apply(s.output, e)
    projected.commands.foldl(unchanged({...s, output: projected.state}), (acc, command) => {
      val result = if (O::isSuppress(command)) suppress(acc.state, O::suppressTarget(command), O::suppressLocal(command)) else unchanged(acc.state)
      {state: result.state, commands: acc.commands.concat(result.commands)}
    })
  }
  pure def canProgress(s: State): bool = not(s.retired) and Set(Listening, Muted).contains(s.capture)
    and not(s.output.closed) and not(s.output.locallyInterrupted)
    and not(s.operations.foldl(false, (found, op) => found or isPrepare(op.kind) or isStop(op.kind)))
    and (match s.output.current {
      | None => false
      | Some(v) => O::active(v.status) and v.manifest and s.output.prepared == Some(v.identity)
        and session(s) == Some(v.session) and s.preparedOutput != Some(v.identity)
    })
  pure def progress(s: State): Result = if (canProgress(s)) match s.output.current {
    | Some(v) => reserve(s, PrepareWork(O::manifestValue(v)), List()) | None => unchanged(s)
  } else unchanged(s)
  pure def prepared(s: State, req: Request, v: O::Output, result: WorkResult): Result = {
    val active = req.generation == s.generation and not(s.retired) and not(s.output.locallyInterrupted)
      and s.output.prepared == Some(v.identity) and O::identity(s.output.current) == Some(v.identity)
    if (not(active) or s.origin == None or not(Set(Listening, Muted).contains(s.capture))) ensureStop(s)
    else if (result == WorkFailed) project(s, O::Fail(v.identity))
    else match s.origin {
      | Some(origin) => reserve({...s, preparedOutput: Some(v.identity)}, ReadyWork({origin: origin, output: v}), List())
      | None => unchanged(s)
    }
  }
  pure def complete(s: State, req: Request, result: WorkResult): Result = {
    val found = s.operations.select(op => op.request == req)
    val settled = {...s, operations: s.operations.select(op => op.request != req)}
    if (found.length() == 0) unchanged(s)
    else if (result == Cancelled) unchanged(settled)
    else match found.head().kind {
      | PrepareWork(v) => prepared(settled, req, v, result)
      | ReadyWork(v) => if (req.generation == s.generation and not(s.retired) and not(found.head().cancelling)
          and s.output.prepared == Some(v.output.identity) and O::identity(s.output.current) == Some(v.output.identity)
          and not(s.output.locallyInterrupted) and result == WorkFailed)
          project(settled, O::Fail(v.output.identity)) else unchanged(settled)
      // Empty ready-success snapshots and stop/interrupt acknowledgements settle work;
      // nonempty canonical observations are explicit Project events in this boundary.
      | _ => unchanged(settled)
    }
  }
  pure def apply(s: State, e: Event): Result = match e {
    | Project(v) => project(s, v)
    | Progress => progress(s)
    | Complete(v) => complete(s, v.request, v.result)
    | Context(v) => unchanged({...s, generation: v.generation, retired: v.retired, capture: v.capture, origin: v.origin})
  }
}
module VoicePreparation {
  import basicSpells.* from "./spells/basicSpells"
  import VoiceOutputCore as O from "./VoiceOutput"
  import VoicePreparationCore.*
  var state: State
  var previous: State
  var event: Option[Event]
  var commands: List[Command]
  action init = all {state' = initial, previous' = initial, event' = None, commands' = List()}
  action deliver(e: Event): bool = {
    val result = apply(state, e)
    all {state' = result.state, previous' = state, event' = Some(e), commands' = result.commands}
  }
  action step = {
    nondet id = O::IDENTITIES.oneOf()
    nondet status = Set(O::Preparing, O::AwaitingReady, O::Playing, O::Delivered, O::Interrupted, O::Failed).oneOf()
    nondet seq = Set(0, 1, 2, 3).oneOf()
    nondet result = Set(Succeeded, WorkFailed, Cancelled).oneOf()
    nondet generation = Set(1, 2).oneOf()
    nondet capture = Set(Listening, Muted, Paused).oneOf()
    nondet retired = Set(false, true).oneOf()
    any {
      all {state.nextRequest <= 5, deliver(Progress)},
      deliver(Project(O::Observe({sequence: seq, output: O::value(id, status)}))),
      all {state.nextRequest <= 5, deliver(Project(O::Cut({nextInput: Some(2), pending: List()})))},
      deliver(Context({generation: generation, capture: capture, retired: retired, origin: Some({session: 1, incarnation: 1})})),
      {
        nondet op = 0.to(state.operations.length() - 1).oneOf()
        deliver(Complete({request: state.operations.nth(op).request, result: result}))
      }
    }
  }
  val reachedProject = match event { | Some(e) => match e { | Project(_) => true | _ => false } | None => false }
  val reachedContext = match event { | Some(e) => match e { | Context(_) => true | _ => false } | None => false }
  val reachedPrepare = commands.foldl(false, (found, c) => found or (match c {
    | Run(v) => match v.kind { | PrepareWork(_) => true | _ => false } | _ => false
  }))
  val reachedReady = commands.foldl(false, (found, c) => found or (match c {
    | Run(v) => match v.kind { | ReadyWork(_) => true | _ => false } | _ => false
  }))
  val reachedCleanup = commands.foldl(false, (found, c) => found or (match c {
    | Run(v) => match v.kind { | StopWork(_) => true | _ => false } | _ => false
  }))
  val reachedCompletion = match event { | Some(e) => match e {
    | Complete(_) => previous.operations.length() > state.operations.length() | _ => false
  } | None => false }
  val noWrongReady = commands.foldl(true, (ok, command) => ok and (match command {
    | Run(v) => match v.kind {
      | ReadyWork(w) => not(state.retired) and Set(Listening, Muted).contains(state.capture)
        and not(state.output.locallyInterrupted) and state.output.prepared == Some(w.output.identity)
        and O::identity(state.output.current) == Some(w.output.identity)
        and v.request.generation == state.generation
      | _ => true
    }
    | _ => true
  }))
  val preparationAuthorized = commands.foldl(true, (ok, command) => ok and (match command {
    | Run(v) => match v.kind {
      | PrepareWork(w) => not(previous.retired) and Set(Listening, Muted).contains(previous.capture)
        and not(previous.output.closed) and not(previous.output.locallyInterrupted)
        and previous.output.prepared == Some(w.identity)
        and O::identity(previous.output.current) == Some(w.identity)
        and (match previous.output.current { | Some(selected) => O::active(selected.status) and selected.manifest | None => false })
        and session(previous) == Some(w.session) and previous.preparedOutput != Some(w.identity)
        and previous.operations.foldl(true, (quiet, op) => quiet and (match op.kind {
          | PrepareWork(_) => false | StopWork(_) => false | _ => true
        }))
      | _ => true
    }
    | _ => true
  }))
  val safety = noWrongReady and preparationAuthorized
}
