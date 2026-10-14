import { randomBytes } from "node:crypto"
import { createRemoteJWKSet } from "jose"
import { Effect } from "effect"
import { subscriptionIdentityVerifier } from "./identity.ts"
import type { SubscriptionPorts } from "./ports.ts"
import { failed, issuer, maximumBodyBytes, timeoutMillis } from "./model.ts"
const entropyBytes = 32
const maximumBodyCharacters = maximumBodyBytes
const boundedJson = async (response: Response) => {
  if (response.body === null) throw new Error("Missing body")
  const reader = response.body.getReader()
  const pieces: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      length += part.value.byteLength
      if (length > maximumBodyBytes) throw new Error("Response too large")
      pieces.push(part.value)
    }
    const text = Buffer.concat(pieces).toString("utf8")
    if (text.length > maximumBodyCharacters) throw new Error("Response too large")
    const parsed: unknown = JSON.parse(text)
    return parsed
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
export const livePorts = (): Pick<SubscriptionPorts, "random" | "request" | "verifyIdentity"> => {
  const keys = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), { timeoutDuration: timeoutMillis })
  return {
    random: () => randomBytes(entropyBytes).toString("base64url"),
    request: subscriptionHttpRequest(),
    verifyIdentity: subscriptionIdentityVerifier(keys)
  }
}

/** A bounded HTTP adapter; the injected Fetch implementation is the transport contract-test seam. */
export function subscriptionHttpRequest(fetcher: typeof fetch = fetch): SubscriptionPorts["request"] {
  return function requestSubscription(url, init) {
    return Effect.tryPromise({
      try: async function fetchSubscriptionResponse(signal) {
        const response = await fetcher(url, {
          ...init,
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMillis)])
        })
        // Never decode or retain arbitrary upstream errors that may echo a token or authorization code.
        if (!response.ok || init.responseMode === "empty") {
          await response.body?.cancel()
          return { status: response.status, body: null }
        }
        return { status: response.status, body: await boundedJson(response) }
      },
      catch: () => failed("Provider", "Subscription provider did not return a bounded valid response")
    }).pipe(
      Effect.timeout(timeoutMillis),
      Effect.catchTag("TimeoutError", () => Effect.fail(failed("Provider", "Subscription provider request timed out")))
    )
  }
}
