/// Small communication composition, not another application implementation.
/// The same relevant Voice owner remains live while its observation transport
/// stalls. Full capture failure and owner replacement are qualified separately.
/// LocalCut assumes interruption intent has already been authorized. Conditional
/// terminal convergence checks communication after that cut, not whether speech
/// was human or assistant echo; convergence can succeed after a false onset.
module VoiceConvergenceCore {
  import basicSpells.* from "./spells/basicSpells"
  import VoiceOutputCore.* from "./VoiceOutput"
  type Origin = {session: int, incarnation: int}
  type Page = {origin: Origin, sequence: int, output: Output}
  type Server = {origin: Origin, output: Output, sequence: int, accepted: Set[int], answers: int}
  type Client = {origin: Origin, live: bool, output: State}
  type Channels = {interruptRequests: List[Identity], interruptAcks: List[Page],
    pollRequests: List[Origin], pollResponses: List[Page], lateResponse: Option[Page]}
  type Network = {up: bool, lossAvailable: bool, outageAvailable: bool, duplicateAvailable: bool}
  type CommunicationEvent = Initial | LocalCut | InterruptServiced | AckDelivered | PollIssued | PollRead
    | PollDelivered | LateCaptured | LateDelivered | Duplicated | Lost | LinkDisconnected
    | Recovered | Finished | Replaced | Retired
  type Violation = TerminalEvidenceLost | OutputReactivated | UnauthorizedPrepare
    | WrongIdentitySelected | ServerReactivated | DurableInputLost | ExtraAnswer
  type System = {server: Server, client: Client, channels: Channels, network: Network,
    cut: bool, replaced: bool, capturedLate: bool, commands: List[Command],
    lastEvent: CommunicationEvent, violations: Set[Violation]}
  pure val ORIGIN: Origin = {session: 1, incarnation: 1}
  pure val initialSystem: System = {server: {origin: ORIGIN, output: value(X, Playing),
      sequence: 0, accepted: Set(1), answers: 1},
    client: {origin: ORIGIN, live: true,
      output: apply(initial, Observe({sequence: 0, output: value(X, Playing)})).state},
    channels: {interruptRequests: List(), interruptAcks: List(), pollRequests: List(),
      pollResponses: List(), lateResponse: None},
    network: {up: true, lossAvailable: true, outageAvailable: true, duplicateAvailable: true},
    cut: false, replaced: false, capturedLate: false, commands: List(), lastEvent: Initial,
    violations: Set()}
  pure def begin(s: System, e: CommunicationEvent): System = {...s, commands: List(), lastEvent: e}
  pure def page(s: System): Page = {origin: s.server.origin, sequence: s.server.sequence, output: s.server.output}
  pure def cutSystem(s: System): System = {
    val projectedCut = apply(s.client.output, Cut({nextInput: None, pending: List()}))
    {...begin(s, LocalCut), cut: true, client: {...s.client, output: projectedCut.state}, commands: projectedCut.commands,
      channels: {...s.channels, interruptRequests: projectedCut.commands.foldl(List(), (acc, command) =>
        match suppressTarget(command) { | Some(target) => acc.append(target) | None => acc })}}
  }
  pure def terminalSystem(s: System, status: Status): System = if (not(active(s.server.output.status))) s
    else {...s, server: {...s.server, output: {...s.server.output, status: status}, sequence: s.server.sequence + 1}}
  pure def serviceInterrupt(s: System): System = {
    val target = s.channels.interruptRequests.head()
    val ended = if (target == s.server.output.identity) terminalSystem(s, Interrupted) else s
    {...begin(ended, InterruptServiced), channels: {...ended.channels,
      interruptRequests: s.channels.interruptRequests.tail(), interruptAcks: s.channels.interruptAcks.append(page(ended))}}
  }
  pure def issuePoll(s: System): System = {...begin(s, PollIssued),
    channels: {...s.channels, pollRequests: List(s.client.origin)}}
  pure def readPoll(s: System): System = {...begin(s, PollRead),
    channels: {...s.channels, pollRequests: s.channels.pollRequests.tail(),
      pollResponses: s.channels.pollResponses.append(page(s))}}
  pure def selectedTerminalRequired(before: Client, evidence: Page): bool = before.live
    and before.origin == evidence.origin and not(before.output.closed)
    and evidence.sequence > before.output.sequence
    and identity(before.output.current) == Some(evidence.output.identity)
    and not(active(evidence.output.status))
    and (match before.output.current { | Some(v) => active(v.status) | None => false })
  pure def addViolation(vs: Set[Violation], valid: bool, v: Violation): Set[Violation] =
    if (valid) vs else vs.union(Set(v))
  pure def commandRights(after: State, commands: List[Command]): bool = commands.foldl(true, (ok, command) => ok and (
    if (isSuppress(command)) true else match after.current {
      | Some(selected) => command == Prepare(manifestValue(selected)) and after.prepared == Some(selected.identity)
        and not(after.locallyInterrupted) and not(after.closed) and active(selected.status)
        and (not(after.gated) or after.allowedInput == Some(selected.identity.input))
      | None => false
    }))
  pure def observePage(s: System, evidence: Page, dropTerminal: bool, resurrect: bool): System = {
    val before = s.client
    val applicable = before.live and before.origin == evidence.origin
    val normal = if (applicable) apply(before.output, Observe({sequence: evidence.sequence, output: evidence.output}))
      else unchanged(before.output)
    val terminalBefore = match before.output.current { | Some(v) => not(active(v.status)) | None => false }
    val illegalRevival = applicable and resurrect and terminalBefore
      and identity(before.output.current) == Some(evidence.output.identity) and active(evidence.output.status)
    val projected = if (dropTerminal and selectedTerminalRequired(before, evidence)) unchanged(before.output)
      else if (illegalRevival) {state: {...normal.state, current: Some(evidence.output), locallyInterrupted: false,
          prepared: Some(evidence.output.identity)}, commands: List(Prepare(manifestValue(evidence.output)))}
      else normal
    val admissionValid = selectedTerminalRequired(before, evidence) implies
      (projected.state.current == Some(evidence.output) and projected.state.prepared == None)
    val nonRegression = (terminalBefore and identity(before.output.current) == Some(evidence.output.identity)) implies
      not(match projected.state.current { | Some(v) => v.identity == evidence.output.identity and active(v.status) | None => false })
    val wrongIdentitySafe = (before.output.current != None and before.output.gated
      and before.output.allowedInput != Some(evidence.output.identity.input)
      and identity(before.output.current) != Some(evidence.output.identity)) implies
      projected.state.current == before.output.current
    val afterAdmission = addViolation(s.violations, admissionValid, TerminalEvidenceLost)
    val afterRegression = addViolation(afterAdmission, nonRegression, OutputReactivated)
    val afterCommands = addViolation(afterRegression, commandRights(projected.state, projected.commands), UnauthorizedPrepare)
    {...s, client: {...before, output: projected.state}, commands: projected.commands,
      violations: addViolation(afterCommands, wrongIdentitySafe, WrongIdentitySelected)}
  }
  pure def deliverPoll(s: System, dropTerminal: bool, resurrect: bool): System = {
    val received = observePage(begin(s, PollDelivered), s.channels.pollResponses.head(), dropTerminal, resurrect)
    {...received, channels: {...received.channels, pollResponses: s.channels.pollResponses.tail()}}
  }
  pure def deliverLate(s: System, dropTerminal: bool, resurrect: bool): System = match s.channels.lateResponse {
    | Some(evidence) => {
      val received = observePage(begin(s, LateDelivered), evidence, dropTerminal, resurrect)
      {...received, channels: {...received.channels, lateResponse: None}}
    }
    | None => s
  }
  pure def replace(s: System): System = {
    val fence = apply(s.client.output, Cut({nextInput: Some(2), pending: List()}))
    {...begin(s, Replaced), replaced: true,
      server: {...s.server, output: value(Y, Playing), sequence: s.server.sequence + 1,
        accepted: s.server.accepted.union(Set(2)), answers: s.server.answers + 1},
      client: {...s.client, output: fence.state}, commands: fence.commands}
  }
  pure def converged(s: System): bool = not(active(s.server.output.status))
    and s.client.live and s.client.origin == s.server.origin
    and s.client.output.current == Some(s.server.output) and s.client.output.prepared == None
  pure def audit(before: System, after: System): System = {
    val serverMonotone = (before.server.output.identity == after.server.output.identity
      and not(active(before.server.output.status))) implies not(active(after.server.output.status))
    val durable = before.server.accepted.forall(id => after.server.accepted.contains(id))
    val noRegeneration = after.lastEvent == Replaced or after.server.answers == before.server.answers
    {...after, violations: addViolation(addViolation(addViolation(after.violations, serverMonotone, ServerReactivated),
      durable, DurableInputLost), noRegeneration, ExtraAnswer)}
  }
  pure def checkSystem(s: System): bool = s.violations.size() == 0 and s.server.accepted.contains(1)
    and s.server.answers == s.server.accepted.size()
    and s.channels.interruptRequests.length() <= 1 and s.channels.interruptAcks.length() <= 1
    and s.channels.pollRequests.length() <= 1 and s.channels.pollResponses.length() <= 2
}
module VoiceConvergenceMachine {
  import basicSpells.* from "./spells/basicSpells"
  import VoiceOutputCore.* from "./VoiceOutput"
  import VoiceConvergenceCore.*
  const allowReplacement: bool
  const allowFinish: bool
  const dropTerminal: bool
  const resurrect: bool
  var system: System
  action init = system' = initialSystem
  action evolve(after: System): bool = system' = audit(system, after)
  action localCut = all {not(system.cut), system.client.live, evolve(cutSystem(system))}
  action serveInterrupt = all {system.network.up, system.channels.interruptRequests.length() > 0,
    system.channels.interruptAcks.length() == 0, evolve(serviceInterrupt(system))}
  action receiveAck = all {system.network.up, system.channels.interruptAcks.length() > 0,
    evolve({...begin(system, AckDelivered), channels: {...system.channels, interruptAcks: system.channels.interruptAcks.tail()}})}
  action requestPoll = all {system.network.up, system.client.live,
    system.channels.pollRequests.length() == 0, system.channels.pollResponses.length() == 0, evolve(issuePoll(system))}
  action readSnapshot = all {system.network.up, system.channels.pollRequests.length() > 0,
    system.channels.pollResponses.length() < 2, evolve(readPoll(system))}
  action receivePoll = all {system.network.up, system.channels.pollResponses.length() > 0,
    evolve(deliverPoll(system, dropTerminal, resurrect))}
  action duplicateObservation = all {system.channels.pollResponses.length() == 1, system.network.duplicateAvailable,
    evolve({...begin(system, Duplicated), network: {...system.network, duplicateAvailable: false},
      channels: {...system.channels, pollResponses: system.channels.pollResponses.append(system.channels.pollResponses.head())}})}
  action loseObservation = all {system.channels.pollResponses.length() > 0, system.network.lossAvailable,
    evolve({...begin(system, Lost), network: {...system.network, lossAvailable: false},
      channels: {...system.channels, pollResponses: system.channels.pollResponses.tail()}})}
  action disconnectLink = all {system.network.up, system.network.outageAvailable,
    evolve({...begin(system, LinkDisconnected), network: {...system.network, up: false, outageAvailable: false}})}
  action recoverLink = all {not(system.network.up), evolve({...begin(system, Recovered), network: {...system.network, up: true}})}
  action captureLate = all {system.network.up, not(system.capturedLate), system.channels.lateResponse == None,
    active(system.server.output.status), evolve({...begin(system, LateCaptured), capturedLate: true,
      channels: {...system.channels, lateResponse: Some(page(system))}})}
  action receiveLate = all {system.network.up, system.channels.lateResponse != None,
    evolve(deliverLate(system, dropTerminal, resurrect))}
  // A retained response from an earlier backend incarnation is an explicit
  // prehistory input. It cannot be created by the current owner's server read.
  action receiveHistorical = all {system.network.up,
    evolve(observePage(begin(system, LateDelivered), {origin: {session: 1, incarnation: 2},
      sequence: 2, output: value(Z, Playing)}, dropTerminal, resurrect))}
  action finish(status: Status): bool = all {allowFinish, active(system.server.output.status),
    not(active(status)), evolve(begin(terminalSystem(system, status), Finished))}
  action replaceOutput = all {allowReplacement, not(system.replaced), system.client.live, evolve(replace(system))}
  action retireOwner = all {allowReplacement, system.client.live,
    evolve({...begin(system, Retired), client: {...system.client, live: false,
      output: apply(system.client.output, Disconnect).state},
      commands: apply(system.client.output, Disconnect).commands})}
  action step = any {localCut, serveInterrupt, receiveAck, requestPoll, readSnapshot, receivePoll,
    duplicateObservation, loseObservation, disconnectLink, recoverLink, captureLate, receiveLate,
    receiveHistorical, finish(Delivered), finish(Failed), replaceOutput, retireOwner}
  action controlDropStep = if (not(system.cut)) localCut
    else if (system.channels.interruptRequests.length() > 0) serveInterrupt
    else if (system.channels.pollRequests.length() > 0) readSnapshot
    else if (system.channels.pollResponses.length() > 0) receivePoll
    else requestPoll
  action controlResurrectionStep = if (not(system.capturedLate)) captureLate
    else if (not(system.cut)) localCut
    else if (system.channels.interruptRequests.length() > 0) serveInterrupt
    else if (converged(system) and system.channels.lateResponse != None) receiveLate
    else if (system.channels.pollRequests.length() > 0) readSnapshot
    else if (system.channels.pollResponses.length() > 0) receivePoll
    else requestPoll
  val safety = checkSystem(system)
  val reachedCut = system.cut
  val reachedServerTerminal = not(active(system.server.output.status))
  val reachedLoss = system.lastEvent == Lost
  val reachedDisconnection = system.lastEvent == LinkDisconnected
  val reachedRecovery = system.lastEvent == Recovered
  val reachedRead = system.lastEvent == PollRead
  val reachedConvergence = converged(system)
  val reachedDelayedAck = system.lastEvent == AckDelivered and converged(system)
  val reachedLateAfterTerminal = system.lastEvent == LateDelivered and converged(system)
  val reachedReplacementPrepare = system.replaced and system.client.output.prepared == Some(Y)
  val reachedDuplicate = system.lastEvent == Duplicated
  // Fair actions service persistently enabled work. The observation fault and
  // outage budgets are each one; recovery never edits the client projection.
  temporal fairServices = localCut.weakFair(Set(system)) and serveInterrupt.weakFair(Set(system))
    and requestPoll.weakFair(Set(system)) and readSnapshot.weakFair(Set(system))
    and receivePoll.weakFair(Set(system)) and recoverLink.weakFair(Set(system))
  temporal unfairConvergence = always(system.cut implies eventually(converged(system)))
  temporal terminalConvergence = fairServices implies always(system.cut implies eventually(always(converged(system))))
}
module VoiceConvergence {
  import VoiceConvergenceMachine(allowReplacement = true, allowFinish = true, dropTerminal = false, resurrect = false).*
}
module VoiceConvergenceStable {
  import VoiceConvergenceMachine(allowReplacement = false, allowFinish = false, dropTerminal = false, resurrect = false).*
}
module VoiceConvergenceDropTerminal {
  import VoiceConvergenceMachine(allowReplacement = false, allowFinish = false, dropTerminal = true, resurrect = false).*
}
module VoiceConvergenceResurrection {
  import VoiceConvergenceMachine(allowReplacement = false, allowFinish = false, dropTerminal = false, resurrect = true).*
}
