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
  `Answer runtime or knowledge tool failed (${tag})`
