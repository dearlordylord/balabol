import { FailureDiagnostic } from "../failure-diagnostic/index.ts"
import type { Stream } from "effect"
import { Context, Schema } from "effect"
const maximumRequestCharacters = 1100000
const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximumRequestCharacters))
export const InferenceRequest = Schema.Struct({
  model: Schema.Literals(["gpt-6.1-sol", "gpt-6-luna"]),
  instructions: text,
  input: text
})
export type InferenceRequest = typeof InferenceRequest.Type
export const InferenceEvent = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("Delta"), text: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("Completed") })
])
export type InferenceEvent = typeof InferenceEvent.Type
export class InferenceFailed extends Schema.TaggedError<InferenceFailed>()("InferenceFailed", {
  diagnostic: Schema.optionalKey(FailureDiagnostic),
  reason: Schema.Literals([
    "Authentication",
    "Quota",
    "Failed",
    "Incomplete",
    "Protocol",
    "Deadline",
    "Limit",
    "Transport"
  ])
}) {}
/** Owns bounded direct Responses inference; cancellation closes only this request, never the credential session. */
export class SubscriptionInference extends Context.Service<
  SubscriptionInference,
  { readonly generate: (request: InferenceRequest) => Stream.Stream<InferenceEvent, InferenceFailed> }
>()("balabol/subscription-inference") {}
export const inferenceFailed = (reason: InferenceFailed["reason"]) =>
  new InferenceFailed({ reason, diagnostic: { category: "Subscription", reason, provider: "subscription" } })
