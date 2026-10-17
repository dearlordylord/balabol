/// Composed capture/output owner after a real, deterministic listening bootstrap.
/// Admissions/checkpoint are empty and loaded. Transport pages have no speech
/// events or pending admissions; this model targets output and owner lifetime.
module VoiceLifecycleCore {
  import basicSpells.* from "./spells/basicSpells"
  import VoiceOutputCore as O from "./VoiceOutput"
  type Request = {generation: int, id: int}
  type Origin = {session: int, incarnation: int}
  type Capture = Listening | Muted | Paused | Resuming | Connecting | HostUnavailable
    | Reconnecting | Ending | Ended
  type Intent = Off | Listen(bool)
  type Timer = Observation(Origin) | CaptureRetry | BootstrapCleanup(Origin)
  type Work = Permission | Languages | Bootstrap({proposal: int, muted: bool})
    | Connect({origin: Origin, muted: bool}) | LocalMute(bool)
    | RemoteMute({origin: Origin, muted: bool}) | Snapshot({origin: Origin, after: int})
    | Seal(Origin) | EndBootstrap(Origin)
    | Stop({capture: bool, output: bool, target: Option[O::Identity], session: Option[int]})
    | Disconnect | Prepare(O::Output) | Ready({origin: Origin, output: O::Output})
    | Interrupt({origin: Origin, target: O::Identity}) | Sleep({milliseconds: int, purpose: Timer})
    | ObservePlatform | RetirePlatform
  type Operation = {request: Request, work: Work, cancelling: bool}
  type Release = {origin: Origin, lastFailure: bool}
  type State = {output: O::State, capture: Capture, intent: Intent, origin: Option[Origin],
    drainingOrigin: Option[Origin], generation: int, sequence: int, snapshotSequence: int,
    retired: bool, shuttingDown: bool, bootstrapKnown: bool, startProposal: Option[int],
    startMuted: bool, resumeProbe: bool, retryStep: int, muteInFlight: bool,
    operations: List[Operation], nextRequest: int, platformObservation: Option[Request],
    activeCapture: Option[Request], preparedOutput: Option[O::Identity], localStop: Option[Request],
    bootstrapReleases: List[Release]}
  type Page = {origin: Origin, sequence: int, firstSequence: int, ended: bool, output: Option[O::Output]}
  type Result = PermissionResult(bool) | LanguagesResult | Bootstrapped({origin: Origin, proposal: int})
    | Connected | LocalMuted | RemoteMuted | SnapshotResult(Page) | Sealed(Page)
    | ProducerUnavailable(Origin) | OutputPrepared | ReadyResult(Page) | InterruptedResult(Page)
    | BootstrapEnded | Stopped | Disconnected | PlatformObserved | PlatformRetired | Elapsed
    | Failed | Cancelled
  type Event = Speech(Request) | SpeechIntent | InputIntent(int) | PlatformPause(Request)
    | Resume(int) | End | Shutdown | CaptureFailed({request: Request, proposal: int})
    | AudioReceived({request: Request, identity: O::Identity})
    | Complete({request: Request, result: Result, proposal: int}) | Mute
  type Command = Run({request: Request, work: Work, after: List[Request]}) | Cancel(List[Request])
    | RefreshConversation | InterruptConversation({after: Request})
  type Transition = {state: State, commands: List[Command]}
  pure val FIRST_ORIGIN: Origin = {session: 1, incarnation: 1}
  pure val initial: State = {output: O::initial, capture: Listening, intent: Listen(false),
    origin: Some(FIRST_ORIGIN), drainingOrigin: None, generation: 1, sequence: 0,
    snapshotSequence: -1, retired: false, shuttingDown: false, bootstrapKnown: true,
    startProposal: Some(1), startMuted: false, resumeProbe: false, retryStep: 0,
    muteInFlight: false, operations: List(
      {request: {generation: 1, id: 6}, work: Snapshot({origin: FIRST_ORIGIN, after: 0}), cancelling: false}),
    nextRequest: 8, platformObservation: Some({generation: 1, id: 1}),
    activeCapture: Some({generation: 1, id: 5}), preparedOutput: None, localStop: None,
    bootstrapReleases: List()}
  pure def unchanged(s: State): Transition = {state: s, commands: List()}
  pure def chain(a: Transition, b: Transition): Transition = {state: b.state, commands: a.commands.concat(b.commands)}
  pure def wants(s: State): bool = match s.intent { | Listen(_) => true | Off => false }
  pure def muted(s: State): bool = match s.intent { | Listen(v) => v | Off => false }
  pure def session(s: State): Option[int] = match s.origin { | Some(o) => Some(o.session) | None => None }
  pure def reserve(s: State, work: Work, after: List[Request]): Transition = {
    val request = {generation: s.generation, id: s.nextRequest}
    {state: {...s, operations: s.operations.append({request: request, work: work, cancelling: false}), nextRequest: s.nextRequest + 1},
      commands: List(Run({request: request, work: work, after: after}))}
  }
  pure def physical(work: Work): bool = match work {
    | Permission => true | Connect(_) => true | LocalMute(_) => true | Stop(_) => true
    | Disconnect => true | Prepare(_) => true | _ => false
  }
  pure def producer(work: Work): bool = match work {
    | Permission => true | Bootstrap(_) => true | Connect(_) => true | LocalMute(_) => true
    | RemoteMute(_) => true | Snapshot(_) => true | Prepare(_) => true | Ready(_) => true
    | Sleep(v) => match v.purpose { | BootstrapCleanup(_) => false | _ => true }
    | _ => false
  }
  pure def outputWork(work: Work): bool = match work { | Prepare(_) => true | Ready(_) => true | _ => false }
  pure def stopping(work: Work): bool = match work { | Stop(v) => v.output | _ => false }
  pure def requests(ops: List[Operation]): List[Request] = ops.foldl(List(), (acc, op) => acc.append(op.request))
  pure def physicalRequests(s: State): List[Request] = requests(s.operations.select(op => physical(op.work)))
  pure def cancel(s: State, outputOnly: bool, preserveObservation: bool): Transition = {
    val selected = s.operations.select(op => not(op.cancelling) and (if (outputOnly) outputWork(op.work)
      else producer(op.work) and not(preserveObservation and (match op.work {
        | Snapshot(_) => true | Sleep(v) => match v.purpose { | Observation(_) => true | _ => false } | _ => false }))))
    val selectedRequests = requests(selected)
    {state: {...s, operations: s.operations.foldl(List(), (acc, op) => acc.append(
      if (selected.foldl(false, (found, chosen) => found or chosen.request == op.request)) {...op, cancelling: true} else op))},
     commands: if (selectedRequests.length() == 0) List() else List(Cancel(selectedRequests))}
  }
  pure def stop(s: State, capture: bool): Transition = {
    val result = reserve(s, Stop({capture: capture, output: true, target: O::identity(s.output.current), session: session(s)}), List())
    {state: {...result.state, localStop: Some({generation: s.generation, id: s.nextRequest})}, commands: result.commands}
  }
  pure def ensureStop(s: State): Transition = {
    val entries = s.operations.select(op => stopping(op.work))
    if (entries.length() == 0) stop(s, false)
    else unchanged({...s, localStop: Some(entries.nth(entries.length() - 1).request)})
  }
  pure def suppress(s: State, target: Option[O::Identity], stopLocal: bool): Transition = {
    val cancelled = if (stopLocal) cancel(s, true, false) else unchanged(s)
    val stopped = if (stopLocal) chain(cancelled, ensureStop(cancelled.state)) else cancelled
    match target {
      | None => stopped
      | Some(id) => match s.origin {
        | None => stopped
        | Some(origin) => chain(stopped, reserve(stopped.state, Interrupt({origin: origin, target: id}),
            if (stopLocal) match stopped.state.localStop { | Some(req) => List(req) | None => List() } else List()))
      }
    }
  }
  pure def project(s: State, e: O::Event): Transition = {
    val projected = O::apply(s.output, e)
    projected.commands.foldl(unchanged({...s, output: projected.state}), (acc, command) =>
      if (O::isSuppress(command)) chain(acc, suppress(acc.state, O::suppressTarget(command), O::suppressLocal(command))) else acc)
  }
  pure def progressObservation(s: State): Transition = match s.origin {
    | None => unchanged(s)
    | Some(origin) => if (not(s.retired) and Set(Listening, Muted).contains(s.capture)
        and not(s.operations.foldl(false, (found, op) => found or (not(op.cancelling) and (match op.work {
          | Snapshot(v) => v.origin == origin
          | Sleep(v) => match v.purpose { | Observation(o) => o == origin | _ => false }
          | _ => false
        }))))) reserve(s, Snapshot({origin: origin, after: s.sequence}), List()) else unchanged(s)
  }
  pure def progressCapture(s: State): Transition = if (not(s.retired) and wants(s)
    and Set(Resuming, Reconnecting).contains(s.capture) and s.drainingOrigin == None
    and not(s.operations.foldl(false, (found, op) => found or physical(op.work) or (match op.work {
      | Bootstrap(_) => true | Sleep(v) => v.purpose == CaptureRetry | _ => false
    })))) reserve(s, Permission, match s.platformObservation {
      | Some(req) => if (s.operations.foldl(false, (found, op) => found or op.request == req)) List(req) else List()
      | None => List()
    }) else unchanged(s)
  pure def progressOutput(s: State): Transition = match s.output.current {
    | None => unchanged(s)
    | Some(v) => if (not(s.retired) and Set(Listening, Muted).contains(s.capture)
        and not(s.output.closed) and not(s.output.locallyInterrupted) and O::active(v.status)
        and v.manifest and s.output.prepared == Some(v.identity) and session(s) == Some(v.session)
        and s.preparedOutput != Some(v.identity) and not(s.operations.foldl(false, (found, op) =>
          found or stopping(op.work) or (match op.work { | Prepare(_) => true | _ => false }))))
      reserve(s, Prepare(O::manifestValue(v)), List()) else unchanged(s)
  }
  pure def progress(step: Transition): Transition = {
    val observation = chain(step, progressObservation(step.state))
    val capture = chain(observation, progressCapture(observation.state))
    chain(capture, progressOutput(capture.state))
  }
  pure def stopBarrier(s: State): List[Request] = match s.localStop { | Some(req) => List(req) | None => List() }
  pure def closeProducer(s: State, origin: Option[Origin], preserveObservation: bool): Transition = {
    val cancelled = cancel(s, false, preserveObservation)
    val stopped = chain(cancelled, stop(cancelled.state, true))
    val disconnects = requests(stopped.state.operations.select(op => op.work == Disconnect))
    val disconnected = chain(stopped, reserve(stopped.state, Disconnect, disconnects.concat(stopBarrier(stopped.state))))
    match origin {
      | None => disconnected
      | Some(o) => if (disconnected.state.operations.foldl(false, (found, op) => found or op.work == Seal(o))) disconnected
        else chain(disconnected, reserve(disconnected.state, Seal(o), stopBarrier(disconnected.state)))
    }
  }
  pure def pause(s: State): Transition = if (not(wants(s)) or Set(Paused, Ending, Ended).contains(s.capture)) unchanged(s)
    else {
      val paused = {...s, capture: Paused, origin: None, generation: s.generation + 1,
        muteInFlight: false, resumeProbe: false, drainingOrigin: s.origin, activeCapture: None}
      val closed = closeProducer(paused, s.origin, false)
      val cut = chain(closed, project(closed.state, O::Cut({nextInput: None, pending: List()})))
      {state: cut.state, commands: cut.commands.concat(match cut.state.localStop {
        | Some(req) => List(InterruptConversation({after: req})) | None => List()
      })}
    }
  pure def end(s: State, shutdown: bool): Transition = if ((s.retired and not(shutdown)) or (not(shutdown) and Set(Ending, Ended).contains(s.capture))) unchanged(s)
    else {
      val ending = {...s, intent: Off, capture: Ending, muteInFlight: false,
        drainingOrigin: if (s.drainingOrigin != None) s.drainingOrigin else s.origin,
        retired: shutdown, platformObservation: None, shuttingDown: shutdown}
      val closed = closeProducer(ending, if (s.origin != None) s.origin else s.drainingOrigin, not(shutdown))
      val platform = chain(closed, reserve(closed.state, RetirePlatform,
        requests(closed.state.operations.select(op => op.work == ObservePlatform))))
      val cut = chain(platform, project(platform.state, O::Disconnect))
      if (not(shutdown)) cut else {
        val selected = cut.state.operations.select(op => not(op.cancelling) and (match op.work {
          | Stop(_) => false | Disconnect => false | Seal(_) => false | EndBootstrap(_) => false
          | Sleep(v) => match v.purpose { | BootstrapCleanup(_) => false | _ => true }
          | Interrupt(_) => false | RetirePlatform => false | _ => true
        }))
        {state: {...cut.state, operations: cut.state.operations.foldl(List(), (acc, op) => acc.append(
          if (selected.foldl(false, (found, chosen) => found or chosen.request == op.request)) {...op, cancelling: true} else op))},
          commands: cut.commands.concat(if (selected.length() > 0) List(Cancel(requests(selected))) else List())}
      }
    }
  pure def resume(s: State, proposal: int): Transition = if (s.capture != Paused or not(wants(s))) unchanged(s)
    else {
      val started = {...s, capture: Resuming, startProposal: Some(proposal), startMuted: muted(s),
        bootstrapKnown: false, retryStep: 0, origin: None, snapshotSequence: -1,
        generation: s.generation + 1, sequence: 0, muteInFlight: false, resumeProbe: true,
        output: O::initial, activeCapture: None}
      val cancelled = cancel(started, false, false)
      val platform = if (cancelled.state.platformObservation != None) cancelled else {
        val result = reserve(cancelled.state, ObservePlatform, requests(cancelled.state.operations.select(op =>
          op.work == ObservePlatform or op.work == RetirePlatform)))
        chain(cancelled, {state: {...result.state, platformObservation: Some({generation: started.generation, id: cancelled.state.nextRequest})}, commands: result.commands})
      }
      match s.drainingOrigin {
        | None => platform
        | Some(o) => if (platform.state.operations.foldl(false, (found, op) => found or (match op.work { | Seal(_) => true | _ => false }))) platform
          else chain(platform, reserve(platform.state, Seal(o), physicalRequests(platform.state)))
      }
    }
  pure def failTransport(s: State, proposal: int): Transition = if (s.retired or Set(Ending, Ended).contains(s.capture)) unchanged(s)
    else {
      val paused = s.capture == Paused or s.resumeProbe
      val retry = not(paused) and wants(s)
      val advancedOwner = {...s, capture: if (paused) Paused else HostUnavailable,
        startProposal: if (s.bootstrapKnown) Some(proposal) else s.startProposal,
        startMuted: if (s.bootstrapKnown) muted(s) else s.startMuted,
        bootstrapKnown: false, origin: None, snapshotSequence: -1,
        generation: s.generation + 1, sequence: 0, muteInFlight: false, resumeProbe: false,
        drainingOrigin: if (s.origin != None) s.origin else s.drainingOrigin, activeCapture: None}
      val closed = closeProducer(advancedOwner, s.origin, false)
      val disconnected = chain(closed, project(closed.state, O::Disconnect))
      if (not(retry)) disconnected else {
        val delays = List(500, 1000, 2000, 4000, 8000)
        val index = if (s.retryStep < 4) s.retryStep else 4
        chain(disconnected, reserve({...disconnected.state, retryStep: if (index < 4) index + 1 else 4},
          Sleep({milliseconds: delays.nth(index), purpose: CaptureRetry}), List()))
      }
    }
  pure def observePage(s: State, origin: Origin, page: Page): Transition =
    if (s.retired or s.origin != Some(origin) or page.origin != origin or page.sequence < s.snapshotSequence) unchanged(s)
    else {
      val advanced = {...s, snapshotSequence: page.sequence,
        sequence: if (page.firstSequence - 1 > s.sequence) page.firstSequence - 1 else s.sequence}
      // Ended pages are not generated in this output-only page projection.
      match page.output {
        | None => unchanged(advanced)
        | Some(v) => if (Set(Listening, Muted).contains(advanced.capture) and O::valid(v)
            and (not(v.manifest) or v.session == origin.session))
          project(advanced, O::Observe({sequence: page.sequence, output: v})) else unchanged(advanced)
      }
    }
  pure def retryRelease(s: State, origin: Origin): Transition = if (
    not(s.bootstrapReleases.foldl(false, (found, release) => found or release.origin == origin))
    or s.operations.foldl(false, (found, op) => found or (match op.work {
      | EndBootstrap(o) => o == origin | Sleep(v) => v.purpose == BootstrapCleanup(origin) | _ => false
    }))) unchanged(s) else reserve(s, EndBootstrap(origin), List())
  pure def release(s: State, origin: Origin): Transition = retryRelease(
    if (s.bootstrapReleases.foldl(false, (found, known) => found or known.origin == origin)) s
      else {...s, bootstrapReleases: s.bootstrapReleases.append({origin: origin, lastFailure: false})}, origin)
  pure def finishRelease(s: State, origin: Origin, failed: bool): Transition = if (
    not(s.bootstrapReleases.foldl(false, (found, release) => found or release.origin == origin))) unchanged(s)
    else if (not(failed)) unchanged({...s, bootstrapReleases: s.bootstrapReleases.select(known => known.origin != origin)})
    else reserve({...s, bootstrapReleases: s.bootstrapReleases.foldl(List(), (acc, known) =>
      acc.append(if (known.origin == origin) {...known, lastFailure: true} else known))},
      Sleep({milliseconds: 500, purpose: BootstrapCleanup(origin)}), List())
  pure def prepared(s: State, req: Request, output: O::Output, failed: bool): Transition = {
    val active = req.generation == s.generation and not(s.retired) and not(s.output.locallyInterrupted)
      and s.output.prepared == Some(output.identity) and O::identity(s.output.current) == Some(output.identity)
    if (not(active) or s.origin == None or not(Set(Listening, Muted).contains(s.capture))) ensureStop(s)
    else if (failed) project(s, O::Fail(output.identity))
    else match s.origin {
      | Some(origin) => reserve({...s, preparedOutput: Some(output.identity)}, Ready({origin: origin, output: output}), List())
      | None => unchanged(s)
    }
  }
  pure def completeKnown(s: State, op: Operation, result: Result, proposal: int): Transition = {
    val current = op.request.generation == s.generation and not(op.cancelling) and not(s.retired)
    if (result == Cancelled) {match op.work {
      | EndBootstrap(origin) => finishRelease(s, origin, true)
      | Sleep(v) => match v.purpose { | BootstrapCleanup(origin) => retryRelease(s, origin) | _ => unchanged(s) }
      | _ => unchanged(s)
    }} else match op.work {
      | Prepare(output) => prepared(s, op.request, output, result == Failed)
      | Ready(v) => if (current and s.output.prepared == Some(v.output.identity)
          and O::identity(s.output.current) == Some(v.output.identity) and not(s.output.locallyInterrupted))
          match result { | ReadyResult(page) => observePage(s, v.origin, page)
            | Failed => project(s, O::Fail(v.output.identity)) | _ => unchanged(s) }
        else unchanged(s)
      | Snapshot(v) => if (not(current)) unchanged(s) else if (result == Failed) failTransport(s, proposal)
        else match result {
          | SnapshotResult(page) => {
            val observed = observePage(s, v.origin, page)
            if (observed.state.origin == Some(v.origin) and wants(observed.state))
              chain(observed, reserve(observed.state, Sleep({milliseconds: 250, purpose: Observation(v.origin)}), List()))
            else observed
          }
          | _ => unchanged(s)
        }
      | Permission => if (current and Set(Resuming, Reconnecting).contains(s.capture)) match result {
          | PermissionResult(allowed) => if (not(allowed)) unchanged(s) else match s.startProposal {
            | Some(id) => reserve({...s, capture: if (s.resumeProbe) Resuming else Connecting}, Bootstrap({proposal: id, muted: s.startMuted}), List())
            | None => unchanged(s)
          }
          | _ => unchanged(s)
        } else unchanged(s)
      | Bootstrap(requested) => match result {
          | Bootstrapped(join) => if (current and Set(Connecting, Resuming).contains(s.capture) and wants(s)
              and s.startProposal == Some(requested.proposal) and join.proposal == requested.proposal) {
              val connected = {...s, bootstrapKnown: true, origin: Some(join.origin)}
              val req = {generation: s.generation, id: s.nextRequest}
              val result = reserve(connected, Connect({origin: join.origin, muted: requested.muted or muted(s)}), physicalRequests(s))
              {state: {...result.state, activeCapture: Some(req)}, commands: result.commands}
            } else release(s, join.origin)
          | Failed => if (current) failTransport(s, proposal) else unchanged(s)
          | _ => unchanged(s)
        }
      | Connect(v) => if (not(current) or not(Set(Connecting, Resuming).contains(s.capture))
          or s.origin != Some(v.origin) or not(wants(s))) reserve(s, Disconnect, physicalRequests(s))
        else if (result == Failed) failTransport(s, proposal)
        else {
          val connected = {...s, capture: if (v.muted) Muted else Listening, retryStep: 0, resumeProbe: false,
            output: {...s.output, closed: false, sequence: -1}}
          val snapshot = reserve(connected, Snapshot({origin: v.origin, after: s.sequence}), List())
          val languages = if (snapshot.state.operations.foldl(false, (found, op) => found or op.work == Languages)) snapshot
            else chain(snapshot, reserve(snapshot.state, Languages, List()))
          val refreshed = {state: languages.state, commands: languages.commands.append(RefreshConversation)}
          if (v.muted != muted(s) or s.startMuted != muted(s)) chain(refreshed,
            reserve({...refreshed.state, muteInFlight: true}, LocalMute(muted(s)), List())) else refreshed
        }
      | Seal(origin) => if (s.drainingOrigin != Some(origin)) unchanged(s)
        else if (result == Failed) unchanged(if (wants(s)) {...s, capture: Paused, resumeProbe: false} else s)
        else match result {
          | ProducerUnavailable(returned) => if (returned == origin) unchanged({...s, drainingOrigin: None}) else unchanged(s)
          | Sealed(page) => if (page.origin != origin) unchanged(s) else if (page.ended) unchanged({...s, drainingOrigin: None})
            else unchanged({...s, capture: Paused, resumeProbe: false})
          | _ => unchanged(s)
        }
      | EndBootstrap(origin) => finishRelease(s, origin, result == Failed)
      | Sleep(v) => match v.purpose {
          | BootstrapCleanup(origin) => retryRelease(s, origin)
          | CaptureRetry => if (op.request.generation == s.generation and not(s.retired)
              and wants(s) and Set(HostUnavailable, Reconnecting).contains(s.capture)) unchanged({...s, capture: Reconnecting}) else unchanged(s)
          | Observation(origin) => if (op.request.generation == s.generation and not(s.retired) and s.origin == Some(origin))
              reserve(s, Snapshot({origin: origin, after: s.sequence}), List()) else unchanged(s)
        }
      | Disconnect => if (op.request.generation == s.generation and s.capture == Ending) unchanged({...s, capture: Ended}) else unchanged(s)
      | LocalMute(value) => if (current) match s.origin {
          | Some(origin) => if (wants(s)) reserve(s, RemoteMute({origin: origin, muted: value}), List()) else unchanged(s)
          | None => unchanged(s)
        } else unchanged(s)
      | RemoteMute(v) => if (current and wants(s) and Set(Listening, Muted).contains(s.capture))
          unchanged({...s, capture: if (v.muted) Muted else Listening, muteInFlight: false}) else unchanged(s)
      | _ => unchanged(s)
    }
  }
  pure def compatible(work: Work, result: Result): bool = if (result == Cancelled) true
    else match work {
      | Permission => match result { | PermissionResult(_) => true | _ => false }
      | Languages => result == LanguagesResult
      | Bootstrap(_) => match result { | Bootstrapped(_) => true | Failed => true | _ => false }
      | Connect(_) => result == Connected or result == Failed
      | LocalMute(_) => result == LocalMuted
      | RemoteMute(_) => result == RemoteMuted
      | Snapshot(_) => match result { | SnapshotResult(_) => true | Failed => true | _ => false }
      | Seal(_) => match result { | Sealed(_) => true | ProducerUnavailable(_) => true | Failed => true | _ => false }
      | EndBootstrap(_) => result == BootstrapEnded or result == Failed
      | Stop(_) => result == Stopped
      | Disconnect => result == Disconnected
      | Prepare(_) => result == OutputPrepared or result == Failed
      | Ready(_) => match result { | ReadyResult(_) => true | Failed => true | _ => false }
      | Interrupt(_) => match result { | InterruptedResult(_) => true | Failed => true | _ => false }
      | Sleep(_) => result == Elapsed
      | ObservePlatform => result == PlatformObserved
      | RetirePlatform => result == PlatformRetired
    }
  pure def complete(s: State, req: Request, result: Result, proposal: int): Transition = {
    val known = s.operations.select(op => op.request == req)
    if (known.length() == 0) unchanged(s)
    else if (not(compatible(known.head().work, result))) unchanged(s)
    else completeKnown({...s, operations: s.operations.select(op => op.request != req)}, known.head(), result, proposal)
  }
  pure def decide(s: State, e: Event): Transition = match e {
    | Complete(v) => complete(s, v.request, v.result, v.proposal)
    | _ => if (s.retired) unchanged(s) else match e {
      | Speech(req) => if (s.activeCapture == Some(req) and s.capture == Listening) project(s, O::Cut({nextInput: None, pending: List()})) else unchanged(s)
      | SpeechIntent => project(s, O::Cut({nextInput: None, pending: List()}))
      | InputIntent(id) => project(s, O::Cut({nextInput: Some(id), pending: List()}))
      | PlatformPause(req) => if (s.platformObservation == Some(req)) pause(s) else unchanged(s)
      | Resume(id) => resume(s, id)
      | End => end(s, false)
      | Shutdown => end(s, true)
      | CaptureFailed(v) => if (s.activeCapture == Some(v.request)) failTransport(s, v.proposal) else unchanged(s)
      | AudioReceived(v) => if (s.activeCapture == Some(v.request)) project(s, O::Audio(v.identity)) else unchanged(s)
      | Mute => if (wants(s) and not(s.muteInFlight)) {
          val updated = {...s, intent: Listen(not(muted(s)))}
          if (Set(Connecting, Resuming).contains(s.capture) and s.bootstrapKnown) failTransport(updated, 2)
          else if (Set(Listening, Muted).contains(s.capture) and s.origin != None)
            reserve({...updated, muteInFlight: true}, LocalMute(not(muted(s))), List()) else unchanged(updated)
        } else unchanged(s)
      | _ => unchanged(s)
    }
  }
  pure def apply(s: State, e: Event): Transition = progress(decide(s, e))
  // Explicit abstraction boundary: permission is granted, language loading and
  // mute operations succeed; active pages omit wire/admission payloads. Failure
  // paths retained here are connection/preparation and resource-release failure.
  pure def inScope(s: State, e: Event): bool = match e {
    | Complete(v) => match v.result {
      | Failed => {
        val known = s.operations.select(op => op.request == v.request)
        if (known.length() != 1) false else match known.head().work {
          | Prepare(_) => true | Ready(_) => true | Snapshot(_) => true | Bootstrap(_) => true
          | Connect(_) => true | Seal(_) => true | EndBootstrap(_) => true | Interrupt(_) => true
          | _ => false
        }
      }
      | Sealed(page) => page.ended
      | Bootstrapped(join) => {
        val known = s.operations.select(op => op.request == v.request)
        if (known.length() != 1) true else match known.head().work {
          | Bootstrap(requested) => join.proposal == requested.proposal | _ => true
        }
      }
      | PermissionResult(allowed) => allowed
      | SnapshotResult(page) => not(page.ended)
      | ReadyResult(page) => not(page.ended)
      | _ => true
    }
    | _ => true
  }
  pure def sampleResult(op: Operation, seq: int, id: O::Identity, status: O::Status): Result = match op.work {
    | Permission => PermissionResult(true)
    | Languages => LanguagesResult
    | Bootstrap(v) => Bootstrapped({origin: {session: 2, incarnation: 2}, proposal: v.proposal})
    | Connect(_) => Connected
    | LocalMute(_) => LocalMuted
    | RemoteMute(_) => RemoteMuted
    | Snapshot(v) => SnapshotResult({origin: v.origin, sequence: seq, firstSequence: 0, ended: false,
        output: Some({...O::value(id, status), session: v.origin.session})})
    | Seal(origin) => ProducerUnavailable(origin)
    | EndBootstrap(_) => BootstrapEnded
    | Stop(_) => Stopped
    | Disconnect => Disconnected
    | Prepare(_) => OutputPrepared
    | Ready(v) => ReadyResult({origin: v.origin, sequence: seq, firstSequence: 0, ended: false,
        output: Some({...O::value(id, status), session: v.origin.session})})
    | Interrupt(v) => InterruptedResult({origin: v.origin, sequence: seq, firstSequence: 0, ended: false,
        output: Some({...O::value(v.target, O::Interrupted), session: v.origin.session})})
    | Sleep(_) => Elapsed
    | ObservePlatform => PlatformObserved
    | RetirePlatform => PlatformRetired
  }
  pure def resultPage(result: Result): Option[Page] = match result {
    | SnapshotResult(page) => Some(page) | ReadyResult(page) => Some(page) | _ => None
  }
  pure def observationOrigin(work: Work): Option[Origin] = match work {
    | Snapshot(v) => Some(v.origin) | Ready(v) => Some(v.origin) | _ => None
  }
  pure def canonicalCandidate(before: State, req: Request, page: Page): bool = {
    val entries = before.operations.select(op => op.request == req)
    if (entries.length() != 1) false else not(before.retired) and req.generation == before.generation and entries.length() == 1
      and not(entries.head().cancelling) and observationOrigin(entries.head().work) == before.origin
      and before.origin == Some(page.origin) and page.sequence >= before.snapshotSequence
      and Set(Listening, Muted).contains(before.capture) and not(before.output.closed)
      and page.sequence > before.output.sequence
  }
  pure def terminalAdmission(before: State, after: State, e: Event): bool = match e {
    | Complete(v) => match resultPage(v.result) {
      | Some(page) => match page.output {
        | Some(output) => (canonicalCandidate(before, v.request, page)
            and O::identity(before.output.current) == Some(output.identity)
            and not(O::active(output.status))
            and (match before.output.current { | Some(old) => O::active(old.status) | None => false }))
          implies (after.output.current == Some(output) and after.output.prepared == None)
        | None => true
      }
      | None => true
    }
    | _ => true
  }
  pure def terminalCannotReactivate(before: State, after: State, e: Event): bool = match e {
    | Complete(v) => match resultPage(v.result) {
      | Some(page) => match page.output {
        | Some(output) => (canonicalCandidate(before, v.request, page)
            and O::identity(before.output.current) == Some(output.identity)
            and (match before.output.current { | Some(old) => not(O::active(old.status)) | None => false }))
          implies (after.output.current == before.output.current)
        | None => true
      }
      | None => true
    }
    | _ => true
  }
  pure def authorizedCommands(after: State, commands: List[Command]): bool = commands.foldl(true, (ok, command) => ok and (match command {
    | Run(v) => match v.work {
      | Prepare(output) => not(after.retired) and Set(Listening, Muted).contains(after.capture)
        and not(after.output.closed) and not(after.output.locallyInterrupted)
        and after.output.prepared == Some(output.identity) and O::identity(after.output.current) == Some(output.identity)
        and session(after) == Some(output.session) and v.request.generation == after.generation
        and after.operations.foldl(true, (quiet, op) => quiet and (op.request == v.request or
          not(stopping(op.work) or (match op.work { | Prepare(_) => true | _ => false }))))
      | Ready(w) => not(after.retired) and Set(Listening, Muted).contains(after.capture)
        and not(after.output.locallyInterrupted) and after.output.prepared == Some(w.output.identity)
        and O::identity(after.output.current) == Some(w.output.identity) and after.origin == Some(w.origin)
        and v.request.generation == after.generation
      | _ => true
    }
    | _ => true
  }))
  pure def retiredCannotRevive(before: State, after: State, commands: List[Command]): bool = before.retired implies (
    after.retired and after.output.closed and after.output.current == None and commands.foldl(true, (ok, command) => ok and (match command {
      | Run(v) => match v.work { | Prepare(_) => false | Ready(_) => false | Permission => false | Bootstrap(_) => false | Connect(_) => false | _ => true }
      | _ => true
    })))
  pure def lateAcquisitionRetained(before: State, after: State, e: Event): bool = match e {
    | Complete(v) => match v.result {
      | Bootstrapped(join) => {
        val entries = before.operations.select(op => op.request == v.request)
        (if (entries.length() != 1) false else (match entries.head().work { | Bootstrap(_) => true | _ => false })
          and (before.retired or v.request.generation != before.generation or entries.head().cancelling))
        implies (after.origin == before.origin and after.bootstrapReleases.foldl(false, (found, release) => found or release.origin == join.origin))
      }
      | _ => true
    }
    | _ => true
  }
}
module VoiceLifecycle {
  import basicSpells.* from "./spells/basicSpells"
  import VoiceLifecycleCore.*
  import VoiceOutputCore as O from "./VoiceOutput"
  var state: State
  var previous: State
  var event: Option[Event]
  var commands: List[Command]
  action init = all {state' = initial, previous' = initial, event' = None, commands' = List()}
  action deliver(e: Event): bool = {
    val result = apply(state, e)
    all {inScope(state, e), previous' = state, state' = result.state, event' = Some(e), commands' = result.commands}
  }
  action sampledCompletion = {
    nondet index = 0.to(state.operations.length() - 1).oneOf()
    nondet seq = Set(0, 1, 2, 3).oneOf()
    nondet id = O::IDENTITIES.oneOf()
    nondet status = Set(O::Preparing, O::AwaitingReady, O::Playing, O::Delivered, O::Interrupted, O::Failed).oneOf()
    val op = state.operations.nth(index)
    nondet result = Set(sampleResult(op, seq, id, status), Cancelled).oneOf()
    deliver(Complete({request: op.request, result: result, proposal: 2}))
  }
  action step = any {
    sampledCompletion,
    deliver(SpeechIntent), deliver(InputIntent(2)), deliver(PlatformPause({generation: 1, id: 1})),
    deliver(Resume(2)), deliver(End), deliver(Shutdown), deliver(Mute),
    deliver(Speech({generation: 1, id: 5})),
    deliver(AudioReceived({request: {generation: 1, id: 5}, identity: O::X})),
    deliver(CaptureFailed({request: {generation: 1, id: 5}, proposal: 2}))
  }
  // Targeted exploration uses the same real events as random scheduling. These
  // actions choose a scheduler, not a replacement transition or Context write.
  action completeFirst = all {
    state.operations.length() > 0,
    deliver(Complete({request: state.operations.head().request,
      result: sampleResult(state.operations.head(), 1, O::X, O::Playing), proposal: 2}))
  }
  action preparationWitnessStep = if (state.preparedOutput != None and not(state.output.receivedAudio))
    match state.activeCapture {
      | Some(req) => deliver(AudioReceived({request: req, identity: O::X}))
      | None => completeFirst
    } else completeFirst
  action muteWitnessStep = if (state.intent == Listen(false)) deliver(Mute) else preparationWitnessStep
  action recoveryWitnessStep = if (state.generation == 1) deliver(CaptureFailed({request: {generation: 1, id: 5}, proposal: 2}))
    else preparationWitnessStep
  action releaseWitnessStep = if (state.generation == 1) deliver(PlatformPause({generation: 1, id: 1}))
    else if (state.capture == Paused and not(state.retired)) deliver(Resume(2))
    else if (not(state.retired) and state.operations.foldl(false, (found, op) => found or (match op.work { | Bootstrap(_) => true | _ => false }))) deliver(Shutdown)
    else completeFirst
  val reachedTerminalObservation = match state.output.current { | Some(v) => not(O::active(v.status)) | None => false }
  val reachedPrepare = commands.foldl(false, (found, c) => found or (match c { | Run(v) => match v.work { | Prepare(_) => true | _ => false } | _ => false }))
  val reachedReady = commands.foldl(false, (found, c) => found or (match c { | Run(v) => match v.work { | Ready(_) => true | _ => false } | _ => false }))
  val reachedPause = state.capture == Paused
  val reachedRecovery = state.generation > 1 and Set(Listening, Muted).contains(state.capture)
  val reachedRetirement = state.retired
  val reachedRelease = state.bootstrapReleases.length() > 0
  val reachedEnd = state.capture == Ended
  val reachedMute = state.capture == Muted
  val reachedAudio = state.output.receivedAudio
  val reachedCleanup = commands.foldl(false, (found, c) => found or (match c { | Run(v) => match v.work { | Stop(_) => true | EndBootstrap(_) => true | _ => false } | _ => false }))
  val safety = match event {
    | Some(e) => terminalAdmission(previous, state, e) and terminalCannotReactivate(previous, state, e)
      and authorizedCommands(state, commands) and retiredCannotRevive(previous, state, commands)
      and lateAcquisitionRetained(previous, state, e)
    | None => true
  }
}
