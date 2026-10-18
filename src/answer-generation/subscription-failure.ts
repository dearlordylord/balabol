import { Schema } from "effect"
import type { FailureDiagnostic } from "../failure-diagnostic/index.ts"
import { AiError } from "effect/ai"
import { InferenceFailed } from "../subscription/index.ts"
const descriptions = {
  Authentication: "ChatGPT authentication failed; reconnect the subscription or switch account",
  Quota: "ChatGPT subscription usage limit reached; check the connected account limits",
  Unavailable: "ChatGPT is temporarily unavailable; try again shortly",
  Failed: "ChatGPT could not generate this answer; try again",
  Incomplete: "ChatGPT returned an incomplete answer; try again",
  Protocol: "ChatGPT returned an unsupported response; the subscription adapter needs attention",
  Deadline: "ChatGPT answer request timed out; try again",
  Limit: "ChatGPT answer exceeded the application request limit",
  Transport: "ChatGPT connection failed; check connectivity and try again"
}
const generic = "Subscription structured answer failed"
// Yielded's streamed failure omits the typed limit; recognize only its pinned local templates.
const policyDescriptions = [
  [/^Agent exceeded its \d+ Turn limit$/, "turn limit reached; try a smaller request"],
  [/^Agent exceeded its \d+ Tool Call limit$/, "tool-call limit reached; try a smaller request"],
  [/^Agent exceeded its [\d.a-zµμ ]+ duration limit$/, "time limit reached; try again"],
  [/^Agent reached its \d+ consecutive Tool Call failure limit$/, "repeated tool failures; try again"],
  [/^Agent exceeded its \d+ token budget$/, "token budget reached; try a smaller request"],
  [/^Agent exceeded its \d+ microdollar cost budget$/, "cost budget reached; try a smaller request"]
] as const
const policyFailureMessage = (tag: string, message: string) => {
  if (tag !== "AgentPolicyError") return undefined
  const matched = policyDescriptions.find(([pattern]) => pattern.test(message))
  return matched === undefined ? undefined : `Answer stopped: agent ${matched[1]}`
}
/** Only locally controlled text crosses the model runtime's opaque failure boundary. */
export const subscriptionProviderError = (failure?: unknown) => {
  const description = failure instanceof InferenceFailed ? descriptions[failure.reason] : generic
  const error = AiError.make({
    module: "balabol/subscription",
    method: "streamText",
    reason: new AiError.UnknownError({ description })
  })
  // Yielded reads only own data properties; Effect AiError.message is a prototype getter.
  Object.defineProperty(error, "message", { value: description, configurable: true })
  return error
}
export const answerRuntimeFailureMessage = (tag: string, message: string) =>
  Object.values(descriptions).find((description) => message.includes(description)) ??
  policyFailureMessage(tag, message) ??
  `Answer runtime or knowledge tool failed (${tag})`

/** SDK strips typed policy errors; only exact pinned local templates recover classification. */
export const answerRuntimeDiagnostic = (tag: string, message: string): FailureDiagnostic => {
  if (tag === "AgentPolicyError") return policyDiagnostic(message)
  if (tag === "KnowledgeUnavailable") return { category: "Knowledge", reason: "Unavailable" }
  if (tag === "DictionaryUnavailable") return { category: "Dictionary", reason: "Unavailable" }
  const subscription = Object.entries(descriptions).find(([, description]) => message.includes(description))
  if (subscription !== undefined) return subscriptionDiagnostic(subscription[0])
  return { category: "Agent", reason: tag === "ToolCallError" ? "ToolFailure" : "RuntimeFailure" }
}
const subscriptionDiagnostic = (key: string): FailureDiagnostic => ({
  category: "Subscription",
  provider: "subscription",
  reason: Schema.is(InferenceFailed.fields.reason)(key) ? key : "Provider"
})
const durationPolicyIndex = 2
const policyReasons = ["Turns", "ToolCalls", "Duration", "RepeatedToolFailures", "Tokens", "Cost"] as const
const policyDiagnostic = (message: string): FailureDiagnostic => {
  const index = policyDescriptions.findIndex(([pattern]) => pattern.test(message))
  const reason = policyReasons[index] ?? "UnknownPolicy"
  // Duration has units; do not misrepresent its textual number as a unitless limit.
  const number = index < 0 || index === durationPolicyIndex ? undefined : message.match(/\b\d+\b/u)?.[0]
  return { category: "Agent", reason, ...(number === undefined ? {} : { limit: Number(number) }) }
}
