import type { DeliveryTicket, ReplyDeliveryUpdate } from "../conversation/index.ts"
import { initialPhrases } from "./phrases.ts"
import type { OutputState, OutputSelection, OutputContext, OutputError } from "./output-state.ts"
import { outputProjection } from "./output-state.ts"
import type { OutputEvent, OutputTransition } from "./output-events.ts"
import type { VoiceDiagnosticInput } from "./diagnostics.ts"
import { terminateOutput, failOutput } from "./output-transition-control.ts"
import { cancelOutputWork } from "./output-transition-resources.ts"
import { forgetSuppression } from "./output-transition-suppression.ts"
import {
  continueOutput,
  outputResult,
  removeOutputOperation,
  outputOperation,
  reserveOutput,
  sameOutputTicket,
  unchangedOutput
} from "./output-transition-result.ts"
const selection = (ticket: DeliveryTicket, outputEpoch: string): OutputSelection => ({
  key: { ticket, outputEpoch },
  phase: "Preparing",
  manifest: null,
  error: null,
  phrases: initialPhrases(),
  replyComplete: false,
  publicationOperation: null,
  phraseOperation: null,
  phraseId: null,
  nextPacketSequence: 0,
  phraseAudioFrames: 0,
  phraseCompleted: false
})
const selectedTicket = (state: OutputState, ticket: DeliveryTicket, outputEpoch: string): OutputTransition => {
  if (state.selected?.key.ticket.deliveryId === ticket.deliveryId) return outputResult(state)
  const cancelled = cancelOutputWork(state, null)
  return { ...cancelled, state: { ...cancelled.state, selected: selection(ticket, outputEpoch) } }
}
const invalidationFailure = (
  state: OutputState,
  update: Extract<ReplyDeliveryUpdate, { kind: "Invalidated" }>
): OutputError => {
  if (state.selected?.error != null) return state.selected.error
  if (update.failure !== undefined) return update.failure
  return {
    code: "AudioUnavailable",
    message:
      update.reason === "Deadline"
        ? "Reply audio delivery exceeded its deadline"
        : "Reply generation or audio delivery failed",
    ...(update.reason === "Deadline" ? { reason: "DeliveryDeadline" } : {})
  }
}
const invalidation = (
  state: OutputState,
  update: Extract<ReplyDeliveryUpdate, { kind: "Invalidated" }>
): OutputTransition => {
  const failed = update.reason === "Failed" || update.reason === "Deadline"
  const result = terminateOutput(
    state,
    failed ? "Failed" : "Interrupted",
    failed ? invalidationFailure(state, update) : null
  )
  const causes: Record<Extract<ReplyDeliveryUpdate, { kind: "Invalidated" }>["reason"], VoiceDiagnosticInput["cause"]> =
    { Interrupted: "conversationInvalidation", Deadline: "deadline", Failed: "failed", Detached: "detach" }
  return {
    ...result,
    commands: [
      {
        kind: "Trace",
        cause: causes[update.reason],
        applied: true,
        target: {
          ...update.ticket,
          ...(state.selected === null ? {} : { outputEpoch: state.selected.key.outputEpoch })
        },
        priorStatus: outputProjection(state)?.status
      },
      ...result.commands
    ]
  }
}
const conflictingTicket = (state: OutputState, ticket: DeliveryTicket): boolean =>
  state.selected?.key.ticket.deliveryId === ticket.deliveryId && !sameOutputTicket(state.selected.key.ticket, ticket)
const validUpdate = (state: OutputState, fact: ReplyDeliveryUpdate): boolean => {
  if (fact.registrationId !== state.registrationId || fact.sequence <= state.lastUpdateSequence) return false
  return (
    fact.kind === "Idle" ||
    (fact.ticket.registrationId === state.registrationId && !conflictingTicket(state, fact.ticket))
  )
}
const update = (
  state: OutputState,
  event: { readonly update: ReplyDeliveryUpdate; readonly outputEpoch: string }
): OutputTransition => {
  const fact = event.update
  if (!validUpdate(state, fact)) return unchangedOutput(state)
  const advanced = { ...state, lastUpdateSequence: fact.sequence }
  if (fact.kind === "Idle") return outputResult(advanced)
  const projected = selectedTicket(advanced, fact.ticket, event.outputEpoch)
  switch (fact.kind) {
    case "Invalidated":
      return continueOutput(projected, (current) =>
        invalidation(forgetSuppression(current, fact.ticket.inputDeliveryId), fact)
      )
    case "Delivered":
      return continueOutput(projected, (current) => terminateOutput(current, "Delivered", null))
    case "Started":
      return state.suppressedAdmissions.some((record) => record.inputDeliveryId === fact.ticket.inputDeliveryId)
        ? continueOutput(projected, (current) => terminateOutput(current, "Interrupted", null))
        : projected
  }
}
const registered = (state: OutputState, event: Extract<OutputEvent, { kind: "Registered" }>): OutputTransition => {
  if (outputOperation(state, event.operation)?.kind !== "Registration") return unchangedOutput(state)
  return update(
    { ...removeOutputOperation(state, event.operation), registrationId: event.registrationId },
    { update: event.snapshot, outputEpoch: event.outputEpoch }
  )
}
const attach = (state: OutputState, context: OutputContext): OutputTransition => {
  if (
    state.retired ||
    state.registrationId !== null ||
    state.obligations.some((entry) => entry.kind === "Registration")
  )
    return unchangedOutput(state)
  const operation = state.nextOperation
  return outputResult(reserveOutput(state, { kind: "Registration", operation, status: "Reserved" }), [
    { kind: "Register", operation, completionMillis: context.completionMillis }
  ])
}
const registrationFailed = (state: OutputState, operation: number): OutputTransition =>
  outputOperation(state, operation)?.kind === "Registration"
    ? outputResult(removeOutputOperation(state, operation))
    : unchangedOutput(state)
const subscriptionFailed = (
  state: OutputState,
  event: Extract<OutputEvent, { kind: "SubscriptionFailed" }>
): OutputTransition => {
  if (event.registrationId !== state.registrationId) return unchangedOutput(state)
  const failed = failOutput(state, event.error)
  const cancelled = cancelOutputWork({ ...failed.state, retired: true }, null)
  return {
    ...cancelled,
    commands: [...failed.commands, ...cancelled.commands],
    decision: { kind: "Rejected", error: event.error }
  }
}
export const transitionOutputDelivery = (
  state: OutputState,
  event: Extract<
    OutputEvent,
    { kind: "Attach" | "Registered" | "RegistrationFailed" | "SubscriptionFailed" | "DeliveryUpdate" }
  >,
  context: OutputContext
): OutputTransition => {
  switch (event.kind) {
    case "Attach":
      return attach(state, context)
    case "Registered":
      return registered(state, event)
    case "SubscriptionFailed":
      return subscriptionFailed(state, event)
    case "DeliveryUpdate":
      return state.retired ? unchangedOutput(state) : update(state, event)
    case "RegistrationFailed":
      return registrationFailed(state, event.operation)
  }
}
