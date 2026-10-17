import { restoredReply } from "./reply-projection.ts"
import type { Receipt, DeliveryPayload } from "../memory/index.ts"
import type { LanguageSpan } from "../language/index.ts"
import { Schema } from "effect"
import { Reply } from "./contracts.ts"
import type { DeliveryTicket, ReplyDeliveryUpdate } from "./delivery.ts"
import type { TerminalState } from "./response-terminal-core/index.ts"

export type ReplyFailure = NonNullable<Reply["error"]>
export type TerminalSelection = Extract<TerminalState, { $: "Persisting" | "Retryable" }>
export type ResponseWork =
  | { readonly kind: "Reserved" }
  | { readonly kind: "PreparingDelivery"; readonly operation: bigint; readonly registrationId: string }
  | { readonly kind: "PreparingContext"; readonly operation: bigint }
  | { readonly kind: "Generating"; readonly operation: bigint; readonly completed: boolean }
  | { readonly kind: "AwaitingDelivery"; readonly ticket: DeliveryTicket }
  | {
      readonly kind: "Settling"
      readonly selectedRevision: bigint
      readonly terminal: TerminalSelection
      readonly payload: DeliveryPayload
      readonly write: "WaitingForCleanup" | "Executing" | "Failed"
      readonly failure: ReplyFailure | undefined
      readonly projection: "Waiting" | "Streaming" | "Delivering"
    }
  | { readonly kind: "Terminal"; readonly terminal: Extract<TerminalState, { $: "Stored" }>; readonly receipt: Receipt }
  | { readonly kind: "Failed"; readonly error: ReplyFailure }
export type ResponseWaiter = {
  readonly requestId: string
  readonly result: "Reply" | "Done"
  readonly failure?: "Ignore"
}
export type ResponseAttempt = {
  readonly attempt: bigint
  readonly input: Receipt
  readonly responseId: string
  readonly responseLanguage: string
  readonly issuedRevision: bigint
  readonly authorization: "Active" | "Revoked"
  readonly sequence: number
  readonly text: string
  readonly languageSpans: readonly LanguageSpan[]
  readonly observer: string | undefined
  readonly ticket: DeliveryTicket | undefined
  readonly startRequest: string | undefined
  readonly waiters: readonly ResponseWaiter[]
  readonly work: ResponseWork
}
export type OwnedResponseWork = {
  readonly operation: bigint
  readonly attempt: bigint
  readonly kind: "Context" | "Provider" | "AttachmentTimer" | "DeliveryTimer" | "DeliveryClock"
  readonly status: "Running" | "Cancelling"
}
export type ResponseState = {
  readonly cleanupWaiters: readonly {
    readonly attempt: bigint
    readonly current: ResponseAttempt
    readonly waiter: ResponseWaiter
  }[]
  readonly cleanupRecoveries: readonly {
    readonly attempt: bigint
    readonly requestId: string
    readonly operation: bigint
    readonly input: Receipt
  }[]
  readonly current: ResponseAttempt | undefined
  readonly revision: bigint
  readonly nextToken: bigint
  readonly workers: readonly OwnedResponseWork[]
  readonly registration:
    | { readonly registrationId: string; readonly completionMillis: number; readonly update: ReplyDeliveryUpdate }
    | undefined
  readonly retryChecks: readonly {
    readonly requestId: string
    readonly expectedAttempt: bigint | undefined
    readonly inputDeliveryId: string
    readonly issuedRevision: bigint
    readonly responseId: string
    readonly operation: bigint
  }[]
}
export const emptyResponseState: ResponseState = {
  cleanupWaiters: [],
  cleanupRecoveries: [],
  current: undefined,
  revision: 0n,
  nextToken: 1n,
  workers: [],
  registration: undefined,
  retryChecks: []
}
export const responseTarget = (response: ResponseAttempt) => ({
  inputDeliveryId: response.input.deliveryId,
  responseId: response.responseId
})
export const sameTarget = (
  response: ResponseAttempt,
  target: { readonly inputDeliveryId: string; readonly responseId: string }
) => response.responseId === target.responseId && response.input.deliveryId === target.inputDeliveryId
export const ticketMatches = (left: DeliveryTicket | undefined, right: DeliveryTicket) =>
  left !== undefined &&
  left.registrationId === right.registrationId &&
  left.deliveryId === right.deliveryId &&
  left.responseId === right.responseId &&
  left.inputDeliveryId === right.inputDeliveryId
const projectReply = (response: ResponseAttempt): Reply => {
  const base = {
    ...responseTarget(response),
    responseLanguage: response.responseLanguage,
    sequence: response.sequence,
    text: response.text,
    languageSpans: response.languageSpans
  }
  switch (response.work.kind) {
    case "Terminal":
      return { ...restoredReply(response.work.receipt, response.input.deliveryId), ...base }
    case "Failed":
      return { ...base, state: "Failed", error: response.work.error, receipt: null }
    case "Settling": {
      const error = response.work.failure
      return error === undefined
        ? { ...base, state: response.work.projection, error: null, receipt: null }
        : { ...base, state: "Failed", error, receipt: null }
    }
    case "AwaitingDelivery":
      return { ...base, state: "Delivering", error: null, receipt: null }
    default:
      return { ...base, state: response.text.length === 0 ? "Waiting" : "Streaming", error: null, receipt: null }
  }
}

export const replyProjection = (response: ResponseAttempt): Reply =>
  Schema.decodeUnknownSync(Reply)(projectReply(response))
