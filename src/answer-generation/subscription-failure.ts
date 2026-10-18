import { AiError } from "effect/ai"
import { InferenceFailed } from "../subscription/index.ts"
const descriptions = {
  Authentication: "ChatGPT authentication failed; reconnect the subscription or switch account",
  Quota: "ChatGPT subscription usage limit reached; check the connected account limits",
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
