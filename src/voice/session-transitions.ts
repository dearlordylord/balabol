import { Match } from "effect"
import type { SessionState } from "./session-state.ts"
import type { SessionEvent } from "./session-events.ts"
import type { SessionTransition } from "./session-transition-result.ts"
import { emit } from "./session-transition-result.ts"
import { transitionControl } from "./session-transition-control.ts"
import { transitionClosure } from "./session-transition-closure.ts"
import { transitionCapture } from "./session-transition-capture.ts"
import { transitionSpeechFence } from "./session-transition-fence.ts"
import { transitionAdmission } from "./session-transition-admission.ts"
export type { SessionTransition } from "./session-transition-result.ts"
/** Compile the routing table once. Adding an event requires an explicit owner;
 * a handwritten narrowing predicate cannot silently route it to Output. */
const dispatch = Match.type<SessionEvent & { readonly state: SessionState }>().pipe(
  Match.discriminatorsExhaustive("kind")({
    Activated: (input) => transitionControl(input.state, input),
    Joined: (input) => transitionControl(input.state, input),
    Renew: (input) => transitionControl(input.state, input),
    Mute: (input) => transitionControl(input.state, input),
    End: (input) => transitionClosure(input.state, input),
    Expire: (input) => transitionClosure(input.state, input),
    Disconnected: (input) => transitionClosure(input.state, input),
    Released: (input) => transitionClosure(input.state, input),
    CaptureFailed: (input) => transitionCapture(input.state, input),
    Frame: (input) => transitionCapture(input.state, input),
    Classified: (input) => transitionCapture(input.state, input),
    Recognition: (input) => transitionCapture(input.state, input),
    Speech: (input) => transitionSpeechFence(input.state, input),
    FenceApplied: (input) => transitionSpeechFence(input.state, input),
    FenceRejected: (input) => transitionSpeechFence(input.state, input),
    Final: (input) => transitionAdmission(input.state, input),
    Prepared: (input) => transitionAdmission(input.state, input),
    AdmissionFailed: (input) => transitionAdmission(input.state, input),
    Accepted: (input) => transitionAdmission(input.state, input),
    AdmissionFinished: (input) => transitionAdmission(input.state, input),
    Output: (input) => emit({ ...input.state, output: input.output }, { kind: "Output", output: input.output })
  })
)
export const transitionSession = (state: SessionState, event: SessionEvent): SessionTransition =>
  dispatch({ ...event, state })
