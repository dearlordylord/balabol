import { Match } from "effect"
import type { OutputState, OutputContext, OutputKey } from "./output-state.ts"
import { outputProjection } from "./output-state.ts"
import type { OutputEvent, OutputTransition } from "./output-events.ts"
import { sameOutputKey, continueOutput, liveOutput } from "./output-transition-result.ts"
import { reconcileOutput } from "./output-transition-resources.ts"
import { transitionOutputControl } from "./output-transition-control.ts"
import { transitionOutputDelivery } from "./output-transition-delivery.ts"
import { transitionOutputPublication } from "./output-transition-publication.ts"
import { transitionOutputReply } from "./output-transition-phrases.ts"
import { transitionOutputSynthesis } from "./output-transition-synthesis.ts"
import { transitionOutputSettlement } from "./output-transition-settlement.ts"
export const initialOutput = (): OutputState => ({
  retired: false,
  registrationId: null,
  lastUpdateSequence: -1,
  selected: null,
  suppressedAdmissions: [],
  latestSpeechSequence: 0,
  obligations: [],
  nextOperation: 1
})
export const outputAuthorized = (state: OutputState, key: OutputKey, publicationOperation: number): boolean => {
  const selected = liveOutput(state, key)
  return (
    selected !== null &&
    selected.publicationOperation === publicationOperation &&
    selected.phase !== "Settling" &&
    state.obligations.some(
      (entry) =>
        entry.kind === "Publication" &&
        entry.operation === publicationOperation &&
        entry.status !== "Releasing" &&
        sameOutputKey(entry.key, key)
    )
  )
}
const dispatch = Match.type<OutputEvent & { readonly state: OutputState; readonly context: OutputContext }>().pipe(
  Match.discriminatorsExhaustive("kind")({
    Attach: (event) => transitionOutputDelivery(event.state, event, event.context),
    Registered: (event) => transitionOutputDelivery(event.state, event, event.context),
    RegistrationFailed: (event) => transitionOutputDelivery(event.state, event, event.context),
    SubscriptionFailed: (event) => transitionOutputDelivery(event.state, event, event.context),
    DeliveryUpdate: (event) => transitionOutputDelivery(event.state, event, event.context),
    Speech: (event) => transitionOutputControl(event.state, event),
    FenceSettled: (event) => transitionOutputControl(event.state, event),
    AdmissionReleased: (event) => transitionOutputControl(event.state, event),
    Interrupt: (event) => transitionOutputControl(event.state, event),
    Retire: (event) => transitionOutputControl(event.state, event),
    PublicationOpened: (event) => transitionOutputPublication(event.state, event, event.context),
    PublicationFailed: (event) => transitionOutputPublication(event.state, event, event.context),
    Ready: (event) => transitionOutputPublication(event.state, event, event.context),
    ReadyDeadline: (event) => transitionOutputPublication(event.state, event, event.context),
    ReplyObserved: (event) => transitionOutputReply(event.state, event, event.context),
    SynthesisPacket: (event) => transitionOutputSynthesis(event.state, event, event.context),
    CaptureFinished: (event) => transitionOutputSynthesis(event.state, event, event.context),
    SynthesisSettled: (event) => transitionOutputSynthesis(event.state, event, event.context),
    Drained: (event) => transitionOutputSettlement(event.state, event),
    WorkFailed: (event) => transitionOutputSettlement(event.state, event),
    DeliverySettled: (event) => transitionOutputSettlement(event.state, event),
    DeliveryRejected: (event) => transitionOutputSettlement(event.state, event),
    InterruptApplied: (event) => transitionOutputSettlement(event.state, event),
    InterruptRejected: (event) => transitionOutputSettlement(event.state, event),
    Unregistered: (event) => transitionOutputSettlement(event.state, event),
    UnregisterRejected: (event) => transitionOutputSettlement(event.state, event),
    Released: (event) => transitionOutputSettlement(event.state, event)
  })
)
export const transitionOutput = (state: OutputState, event: OutputEvent, context: OutputContext): OutputTransition => {
  const dispatched = dispatch({ ...event, state, context })
  const reconciled = continueOutput(dispatched, reconcileOutput)
  const result = { ...reconciled, decision: dispatched.decision }
  const projection = outputProjection(result.state)
  return projection !== null && JSON.stringify(projection) !== JSON.stringify(outputProjection(state))
    ? { ...result, commands: [...result.commands, { kind: "Project", output: projection }] }
    : result
}
