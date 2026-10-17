module VoicePreparationTest {
  import basicSpells.* from "./spells/basicSpells"
  import VoiceOutputCore as O from "./VoiceOutput"
  import VoicePreparationCore.* from "./VoicePreparation"
  import VoicePreparation.* from "./VoicePreparation"
  run preparationTest = init
    .then(deliver(Project(O::Observe({sequence: 0, output: O::value(O::X, O::AwaitingReady)}))))
    .then(deliver(Progress)).expect(state.operations.length() == 1)
    .then(deliver(Complete({request: {generation: 1, id: 1}, result: Succeeded})))
    .expect(state.preparedOutput == Some(O::X) and state.operations.length() == 1)
    .then(deliver(Progress)).expect(commands == List())
  run latePreparationTest = init
    .then(deliver(Project(O::Observe({sequence: 0, output: O::value(O::X, O::Playing)}))))
    .then(deliver(Progress))
    .then(deliver(Project(O::Cut({nextInput: Some(2), pending: List()}))))
    .then(deliver(Project(O::Observe({sequence: 1, output: O::value(O::Y, O::AwaitingReady)}))))
    .then(deliver(Progress)).expect(commands == List())
    .then(deliver(Complete({request: {generation: 1, id: 1}, result: Succeeded})))
    .expect(state.preparedOutput == None)
    .then(deliver(Complete({request: {generation: 1, id: 2}, result: Succeeded})))
    .then(deliver(Progress)).expect(state.operations.length() == 2)
  run staleGenerationTest = init
    .then(deliver(Project(O::Observe({sequence: 0, output: O::value(O::X, O::Playing)}))))
    .then(deliver(Progress))
    .then(deliver(Context({generation: 2, retired: true, capture: Paused, origin: None})))
    .then(deliver(Complete({request: {generation: 1, id: 1}, result: Succeeded})))
    .expect(state.preparedOutput == None)
    .then(deliver(Progress)).expect(commands == List())
  run failedPreparationTest = init
    .then(deliver(Project(O::Observe({sequence: 0, output: O::value(O::X, O::Playing)}))))
    .then(deliver(Progress))
    .then(deliver(Complete({request: {generation: 1, id: 1}, result: WorkFailed})))
    .expect(state.output.unavailable and state.preparedOutput == None)
  run cancelledPreparationTest = init
    .then(deliver(Project(O::Observe({sequence: 0, output: O::value(O::X, O::Playing)}))))
    .then(deliver(Progress))
    .then(deliver(Complete({request: {generation: 1, id: 1}, result: Cancelled})))
    .expect(state.operations == List())
    .then(deliver(Complete({request: {generation: 1, id: 1}, result: Succeeded})))
    .expect(commands == List())
  run mutedAndOriginGateTest = init
    .then(deliver(Project(O::Observe({sequence: 0, output: O::value(O::X, O::AwaitingReady)}))))
    .then(deliver(Context({generation: 1, retired: false, capture: Paused, origin: Some({session: 1, incarnation: 1})})))
    .then(deliver(Progress)).expect(commands == List())
    .then(deliver(Context({generation: 1, retired: false, capture: Muted, origin: Some({session: 2, incarnation: 1})})))
    .then(deliver(Progress)).expect(commands == List())
    .then(deliver(Context({generation: 1, retired: false, capture: Muted, origin: Some({session: 1, incarnation: 2})})))
    .then(deliver(Progress)).expect(commands.length() == 1)
    .then(deliver(Complete({request: {generation: 2, id: 1}, result: Succeeded}))).expect(commands == List())
    .then(deliver(Complete({request: {generation: 1, id: 1}, result: Succeeded}))).expect(state.preparedOutput == Some(O::X))
  run generationOnlyTest = init
    .then(deliver(Project(O::Observe({sequence: 0, output: O::value(O::X, O::Playing)}))))
    .then(deliver(Progress))
    .then(deliver(Context({generation: 2, retired: false, capture: Listening, origin: Some({session: 1, incarnation: 1})})))
    .then(deliver(Complete({request: {generation: 1, id: 1}, result: Succeeded})))
    .expect(state.preparedOutput == None and state.operations.length() == 1)
  run retiredOnlyTest = init
    .then(deliver(Project(O::Observe({sequence: 0, output: O::value(O::X, O::Playing)}))))
    .then(deliver(Progress))
    .then(deliver(Context({generation: 1, retired: true, capture: Listening, origin: Some({session: 1, incarnation: 1})})))
    .then(deliver(Complete({request: {generation: 1, id: 1}, result: Succeeded})))
    .expect(state.preparedOutput == None and state.operations.length() == 1)
  run originMissingCompletionTest = init
    .then(deliver(Project(O::Observe({sequence: 0, output: O::value(O::X, O::Playing)}))))
    .then(deliver(Progress))
    .then(deliver(Context({generation: 1, retired: false, capture: Listening, origin: None})))
    .then(deliver(Complete({request: {generation: 1, id: 1}, result: Succeeded})))
    .expect(state.preparedOutput == None and state.operations.length() == 1)
  run pausedCompletionTest = init
    .then(deliver(Project(O::Observe({sequence: 0, output: O::value(O::X, O::Playing)}))))
    .then(deliver(Progress))
    .then(deliver(Context({generation: 1, retired: false, capture: Paused, origin: Some({session: 1, incarnation: 1})})))
    .then(deliver(Complete({request: {generation: 1, id: 1}, result: Succeeded})))
    .expect(state.preparedOutput == None and state.operations.length() == 1)
  run readyFailureTest = init
    .then(deliver(Project(O::Observe({sequence: 0, output: O::value(O::X, O::Playing)}))))
    .then(deliver(Progress))
    .then(deliver(Complete({request: {generation: 1, id: 1}, result: Succeeded})))
    .then(deliver(Complete({request: {generation: 1, id: 2}, result: WorkFailed})))
    .expect(state.output.unavailable and state.operations.length() == 1)
}
