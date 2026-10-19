import { composeRecognition, settleRecognition, transitionRecognitionInput } from "./session-transition-recognition.ts"
import { transitionSessionOutput } from "./session-transition-output.ts"
import { Match } from "effect"
import type { SessionState } from "./session-state.ts"
import type { SessionEvent } from "./session-events.ts"
import type { SessionTransition } from "./session-transition-result.ts"
import { transitionControl } from "./session-transition-control.ts"
import { transitionClosure } from "./session-transition-closure.ts"
import { transitionCapture } from "./session-transition-capture.ts"
import { transitionSpeechFence } from "./session-transition-fence.ts"
import { transitionAdmission } from "./session-transition-admission.ts"
import { reconcileSessionExpiry, transitionSessionExpiry } from "./session-expiry.ts"
export type { SessionTransition } from "./session-transition-result.ts"
/** Compile the routing table once. Adding an event requires an explicit owner;
 * a handwritten narrowing predicate cannot silently route it to Output. */
const dispatch = Match.type<SessionEvent & { readonly state: SessionState }>().pipe(
  Match.discriminatorsExhaustive("kind")({
    InitializeExpiry: (input) => transitionSessionExpiry(input.state, input),
    ExpiryDue: (input) => transitionSessionExpiry(input.state, input),
    Activated: (input) => transitionControl(input.state, input),
    Joined: (input) => transitionControl(input.state, input),
    Renew: (input) => transitionControl(input.state, input),
    Mute: (input) => transitionControl(input.state, input),
    End: (input) => transitionClosure(input.state, input),
    Expire: (input) => transitionClosure(input.state, input),
    Disconnected: (input) => transitionClosure(input.state, input),
    Released: (input) => transitionClosure(input.state, input),
    CaptureGap: (input) => transitionCapture(input.state, input),
    CaptureFailed: (input) => transitionCapture(input.state, input),
    Frame: (input) => transitionCapture(input.state, input),
    Classified: (input) => transitionCapture(input.state, input),
    Recognition: (input) => transitionRecognitionInput(input.state, input.input),
    Speech: (input) => transitionSpeechFence(input.state, input),
    FenceApplied: (input) => transitionSpeechFence(input.state, input),
    FenceRejected: (input) => transitionSpeechFence(input.state, input),
    Prepared: (input) => transitionAdmission(input.state, input),
    AdmissionFailed: (input) => transitionAdmission(input.state, input),
    Accepted: (input) => transitionAdmission(input.state, input),
    AdmissionFinished: (input) => transitionAdmission(input.state, input),
    Output: (input) => transitionSessionOutput(input.state, input.input)
  })
)
export const transitionSession = (state: SessionState, event: SessionEvent): SessionTransition => {
  const selected = dispatch({ ...event, state })
  const result = closeBrokenSubscription(selected, event)
  const fenced =
    state.generation === result.state.generation || event.kind === "Mute" || event.kind === "CaptureGap"
      ? result
      : composeRecognition(result, { kind: "Reset", generation: result.state.generation })
  return reconcileSessionExpiry(settleRecognition(fenced))
}
/** A dead delivery subscription cannot silently leave a live voice session
 * without an output consumer. Recovery starts a fresh scoped session. */
const closeBrokenSubscription = (result: SessionTransition, event: SessionEvent): SessionTransition => {
  if (event.kind !== "Output" || event.input.kind !== "SubscriptionFailed" || result.error === undefined) return result
  const closed = transitionClosure(result.state, {
    kind: "Disconnected",
    code: "AudioUnavailable",
    message: "Reply delivery subscription failed"
  })
  return { ...result, state: closed.state, commands: [...result.commands, ...closed.commands] }
}
