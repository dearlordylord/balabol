import { withAuditSpan } from "../operation-audit/index.ts"
import { randomBytes } from "node:crypto"
import { createRemoteJWKSet } from "jose"
import { Effect } from "effect"
import { subscriptionIdentityVerifier } from "./identity.ts"
import type { SubscriptionPorts } from "./ports.ts"
import { issuer, maximumBodyBytes, timeoutMillis, SubscriptionFailed } from "./model.ts"
const entropyBytes = 32
const maximumBodyCharacters = maximumBodyBytes
const classifiedFailure = (reason: "Protocol" | "Transport" | "Deadline" | "Limit") =>
  new SubscriptionFailed({
    kind: "Provider",
    message:
      reason === "Deadline"
        ? "Subscription provider request timed out"
        : "Subscription provider did not return a bounded valid response",
    diagnostic: { category: "Subscription", provider: "subscription", reason }
  })
const providerFailure = () => classifiedFailure("Protocol")
const transportFailure = () => classifiedFailure("Transport")
const cleanupMillis = 1000
const release = (work: Effect.Effect<unknown, unknown>) =>
  work.pipe(
    Effect.interruptible,
    Effect.timeout(cleanupMillis),
    Effect.mapError((error) => (error instanceof SubscriptionFailed ? error : classifiedFailure("Deadline"))),
    withAuditSpan("subscription.release"),
    Effect.ignore
  )
const cancelBody = (response: Response) =>
  release(Effect.tryPromise({ try: () => response.body?.cancel() ?? Promise.resolve(), catch: providerFailure }))
const boundedJson = (response: Response) =>
  Effect.gen(function* () {
    const body = response.body
    if (body === null) return yield* providerFailure()
    const reader = yield* Effect.acquireRelease(
      Effect.try({ try: () => body.getReader(), catch: providerFailure }),
      (reader) =>
        release(Effect.tryPromise({ try: () => reader.cancel(), catch: providerFailure })).pipe(
          Effect.andThen(release(Effect.try({ try: () => reader.releaseLock(), catch: providerFailure })))
        )
    )
    const pieces: Uint8Array[] = []
    let length = 0
    for (;;) {
      const part = yield* Effect.tryPromise({ try: () => reader.read(), catch: providerFailure })
      if (part.done) break
      length += part.value.byteLength
      if (length > maximumBodyBytes) return yield* classifiedFailure("Limit")
      pieces.push(part.value)
    }
    const text = Buffer.concat(pieces).toString("utf8")
    if (text.length > maximumBodyCharacters) return yield* classifiedFailure("Limit")
    return yield* Effect.try({ try: (): unknown => JSON.parse(text), catch: providerFailure })
  })
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
    return Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: (signal) =>
          fetcher(url, {
            ...init,
            redirect: "error",
            signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMillis)])
          }),
        catch: transportFailure
      })
      // Upstream error bodies may echo credentials; consume no error payload.
      if (!response.ok || init.responseMode === "empty") {
        yield* cancelBody(response)
        return { status: response.status, body: null }
      }
      return { status: response.status, body: yield* boundedJson(response) }
    }).pipe(
      Effect.scoped,
      Effect.timeout(timeoutMillis),
      Effect.catchTag("TimeoutError", () => Effect.fail(classifiedFailure("Deadline"))),
      withAuditSpan("subscription.credentials")
    )
  }
}
