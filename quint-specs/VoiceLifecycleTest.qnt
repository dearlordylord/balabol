module VoiceLifecycleTest {
  import basicSpells.* from "./spells/basicSpells"
  import VoiceOutputCore as O from "./VoiceOutput"
  import VoiceLifecycleCore.* from "./VoiceLifecycle"
  import VoiceLifecycle.* from "./VoiceLifecycle"
  pure def page(seq: int, id: O::Identity, status: O::Status): Page = {
    origin: FIRST_ORIGIN, sequence: seq, firstSequence: 0, ended: false, output: Some(O::value(id, status))}
  action finish(id: int, result: Result): bool = deliver(Complete({request: {generation: 1, id: id}, result: result, proposal: 2}))
  action finishWork(work: Work, result: Result): bool = {
    val entries = state.operations.select(op => op.work == work)
    all {entries.length() > 0, deliver(Complete({request: entries.head().request, result: result, proposal: 2}))}
  }
  action tick: bool = {
    val entries = state.operations.select(op => not(op.cancelling) and (match op.work {
      | Sleep(v) => match v.purpose { | Observation(_) => true | _ => false } | _ => false
    }))
    all {entries.length() > 0, deliver(Complete({request: entries.head().request, result: Elapsed, proposal: 2}))}
  }
  action snapshot(page: Page): bool = {
    val entries = state.operations.select(op => not(op.cancelling) and (match op.work { | Snapshot(_) => true | _ => false }))
    all {entries.length() > 0, deliver(Complete({request: entries.head().request, result: SnapshotResult(page), proposal: 2}))}
  }
  run restartSealRetryTest = init.then(snapshot(page(0, O::X, O::Playing)))
    .then(deliver(CaptureFailed({request: {generation: 1, id: 5}, proposal: 2})))
    .then(finishWork(Seal(FIRST_ORIGIN), Failed))
    .expect(state.capture == HostUnavailable and state.drainingOrigin == Some(FIRST_ORIGIN))
    .then(finishWork(Sleep({milliseconds: 500, purpose: CaptureRetry}), Elapsed))
    .expect(state.capture == Reconnecting and state.drainingOrigin == Some(FIRST_ORIGIN))
    .then(finishWork(Seal(FIRST_ORIGIN), ProducerUnavailable(FIRST_ORIGIN)))
    .expect(state.drainingOrigin == None and state.capture != Paused)
  run rejectedSealRequiresResumeTest = init
    .then(deliver(CaptureFailed({request: {generation: 1, id: 5}, proposal: 2})))
    .then(finishWork(Seal(FIRST_ORIGIN), SealRejected))
    .expect(state.capture == Paused and state.drainingOrigin == Some(FIRST_ORIGIN))
  run interruptedObservationTest = init
    .then(finish(6, SnapshotResult(page(0, O::X, O::Playing))))
    .then(deliver(Speech({generation: 1, id: 5})))
    .then(finish(11, InterruptedResult(page(1, O::X, O::Interrupted))))
    .expect(state.output.current == Some(O::value(O::X, O::Playing)))
    .then(finish(8, Elapsed))
    .then(finish(12, SnapshotResult(page(2, O::X, O::Interrupted))))
    .expect(state.output.current == Some(O::value(O::X, O::Interrupted)))
  run cutDeliveredTest = init.then(snapshot(page(0, O::X, O::Playing)))
    .then(deliver(Speech({generation: 1, id: 5})))
    .then(tick).then(snapshot(page(1, O::X, O::Delivered)))
    .expect(state.output.current == Some(O::value(O::X, O::Delivered)))
  run cutFailedTest = init.then(snapshot(page(0, O::X, O::Playing)))
    .then(deliver(Speech({generation: 1, id: 5})))
    .then(tick).then(snapshot(page(1, O::X, O::Failed)))
    .expect(state.output.current == Some(O::value(O::X, O::Failed)))
  run nongatedDeliveredCannotReactivateTest = init.then(snapshot(page(0, O::X, O::Playing)))
    .then(tick).then(snapshot(page(1, O::X, O::Delivered)))
    .then(tick).then(snapshot(page(2, O::X, O::Playing)))
    .expect(state.output.current == Some(O::value(O::X, O::Delivered)))
  run nongatedInterruptedCannotReactivateTest = init.then(snapshot(page(0, O::X, O::Playing)))
    .then(tick).then(snapshot(page(1, O::X, O::Interrupted)))
    .then(tick).then(snapshot(page(2, O::X, O::Playing)))
    .expect(state.output.current == Some(O::value(O::X, O::Interrupted)))
  run nongatedFailedCannotReactivateTest = init.then(snapshot(page(0, O::X, O::Playing)))
    .then(tick).then(snapshot(page(1, O::X, O::Failed)))
    .then(tick).then(snapshot(page(2, O::X, O::Playing)))
    .expect(state.output.current == Some(O::value(O::X, O::Failed)))
  run mutedTerminalTest = init.then(snapshot(page(0, O::X, O::Playing)))
    .then(deliver(Mute)).then(finishWork(LocalMute(true), LocalMuted))
    .then(finishWork(RemoteMute({origin: FIRST_ORIGIN, muted: true}), RemoteMuted))
    .expect(state.capture == Muted)
    .then(deliver(SpeechIntent)).then(tick).then(snapshot(page(1, O::X, O::Interrupted)))
    .expect(state.output.current == Some(O::value(O::X, O::Interrupted)))
  run pauseLateTerminalTest = init.then(snapshot(page(0, O::X, O::Playing)))
    .then(tick).then(deliver(PlatformPause({generation: 1, id: 1})))
    .then(finish(10, SnapshotResult(page(1, O::X, O::Interrupted))))
    .expect(state.capture == Paused and state.output.current == Some(O::value(O::X, O::Playing)) and state.output.locallyInterrupted)
  run retiredLatePreparationTest = init.then(snapshot(page(0, O::X, O::Playing)))
    .then(deliver(Shutdown)).expect(state.retired and state.output.closed)
    .then(finish(9, OutputPrepared))
    .expect(state.retired and state.output.closed and state.preparedOutput == None)
    .then(deliver(SpeechIntent)).expect(state.output.current == None)
  run recoveryRejectsOldOriginTest = init
    .then(deliver(CaptureFailed({request: {generation: 1, id: 5}, proposal: 2})))
    .expect(state.capture == HostUnavailable)
    .then(finishWork(Stop({capture: true, output: true, target: None, session: None}), Stopped))
    .then(finishWork(Disconnect, Disconnected))
    .then(finishWork(Seal(FIRST_ORIGIN), ProducerUnavailable(FIRST_ORIGIN)))
    .then(finishWork(Sleep({milliseconds: 500, purpose: CaptureRetry}), Elapsed))
    .then(finishWork(Permission, PermissionResult(true)))
    .then(finishWork(Bootstrap({proposal: 2, muted: false}), Bootstrapped({origin: {session: 2, incarnation: 2}, proposal: 2})))
    .then(finishWork(Connect({origin: {session: 2, incarnation: 2}, muted: false}), Connected))
    .then(finishWork(Languages, LanguagesResult))
    .then(snapshot({origin: {session: 2, incarnation: 2}, sequence: 0, firstSequence: 0, ended: false,
      output: Some({...O::value(O::Y, O::Playing), session: 2})}))
    .expect(state.capture == Listening and O::identity(state.output.current) == Some(O::Y))
    .then(finish(6, SnapshotResult(page(3, O::X, O::Interrupted))))
    .expect(O::identity(state.output.current) == Some(O::Y))
  run lateBootstrapReleaseAfterRetirementTest = init
    .then(deliver(PlatformPause({generation: 1, id: 1})))
    .then(deliver(Resume(2)))
    .then(finishWork(Stop({capture: true, output: true, target: None, session: None}), Stopped))
    .then(finishWork(Disconnect, Disconnected))
    .then(finishWork(Seal(FIRST_ORIGIN), ProducerUnavailable(FIRST_ORIGIN)))
    .then(finishWork(Permission, PermissionResult(true)))
    .then(deliver(Shutdown))
    .then(finishWork(Bootstrap({proposal: 2, muted: false}), Bootstrapped({origin: {session: 2, incarnation: 2}, proposal: 2})))
    .expect(state.retired and state.origin == None and state.bootstrapReleases.length() == 1)
    .then(finishWork(EndBootstrap({session: 2, incarnation: 2}), Failed))
    .expect(state.bootstrapReleases.head().lastFailure)
    .then(finishWork(Sleep({milliseconds: 500, purpose: BootstrapCleanup({session: 2, incarnation: 2})}), Elapsed))
    .then(finishWork(EndBootstrap({session: 2, incarnation: 2}), BootstrapEnded))
    .expect(state.bootstrapReleases == List() and state.retired)
  run authorizedReplacementAfterReleaseTest = init
    .then(snapshot(page(0, O::X, O::Playing)))
    .then(deliver(InputIntent(2)))
    .then(tick).then(snapshot(page(1, O::Y, O::AwaitingReady)))
    .expect(state.output.prepared == Some(O::Y))
    .then(finish(9, OutputPrepared)).expect(state.preparedOutput == None)
    .then(finishWork(Stop({capture: false, output: true, target: Some(O::X), session: Some(1)}), Stopped))
    .then(finishWork(Prepare(O::manifestValue(O::value(O::Y, O::AwaitingReady))), OutputPrepared))
    .expect(state.preparedOutput == Some(O::Y))
  run endRejectsLateOutputTest = init.then(snapshot(page(0, O::X, O::Playing)))
    .then(deliver(End)).expect(state.output.closed and state.capture == Ending)
    .then(finish(9, OutputPrepared)).expect(state.output.current == None)
    .then(finishWork(Disconnect, Disconnected)).expect(state.capture == Ended)
  run recoveryReopensSequencePreservingInputGateTest = init
    .then(snapshot(page(7, O::X, O::Playing))).then(tick)
    .then(deliver(CaptureFailed({request: {generation: 1, id: 5}, proposal: 2})))
    .then(finish(9, OutputPrepared))
    .then(finishWork(Stop({capture: true, output: true, target: Some(O::X), session: None}), Stopped))
    .then(finishWork(Disconnect, Disconnected))
    .then(finishWork(Seal(FIRST_ORIGIN), ProducerUnavailable(FIRST_ORIGIN)))
    .then(finishWork(Sleep({milliseconds: 500, purpose: CaptureRetry}), Elapsed))
    .then(finishWork(Permission, PermissionResult(true)))
    .then(finishWork(Bootstrap({proposal: 2, muted: false}), Bootstrapped({origin: {session: 2, incarnation: 2}, proposal: 2})))
    .then(deliver(InputIntent(2)))
    .then(finish(10, SnapshotResult(page(8, O::X, O::Interrupted))))
    .then(finish(9, OutputPrepared)).expect(state.output.closed)
    .then(finishWork(Connect({origin: {session: 2, incarnation: 2}, muted: false}), Connected))
    .expect(not(state.output.closed) and state.output.sequence == -1 and state.output.gated and state.output.allowedInput == Some(2))
    .then(finishWork(Languages, LanguagesResult))
    .then(snapshot({origin: {session: 2, incarnation: 2}, sequence: 0, firstSequence: 0, ended: false,
      output: Some({...O::value(O::X, O::Playing), session: 2})}))
    .expect(state.output.locallyInterrupted and state.output.prepared == None)
    .then(tick).then(snapshot({origin: {session: 2, incarnation: 2}, sequence: 1, firstSequence: 0, ended: false,
      output: Some({...O::value(O::Y, O::Playing), session: 2})}))
    .expect(O::identity(state.output.current) == Some(O::Y) and state.output.prepared == Some(O::Y))
}
