import type { JWTPayload, JWTVerifyGetKey } from "jose"
import { jwtVerify } from "jose"
import { Clock, Effect, Redacted } from "effect"
import { failed, issuer, timeoutMillis } from "./model.ts"
import type { SubscriptionPorts } from "./ports.ts"
const validAuthorizedParty = (payload: JWTPayload, clientId: string) => {
  const multiple = Array.isArray(payload.aud) && payload.aud.length > 1
  return !(multiple || payload.azp !== undefined) || payload.azp === clientId
}
/** The adapter validates signed claims; key resolution is the only fixture seam, never a bypass of claim validation. */
export function subscriptionIdentityVerifier(keys: JWTVerifyGetKey): SubscriptionPorts["verifyIdentity"] {
  return function verifyIdentity(token, clientId, nonce) {
    return Effect.gen(function* verifyClaims() {
      const now = yield* Clock.currentTimeMillis
      return yield* Effect.tryPromise({
        try: async function verifySignedIdentity() {
          const { payload } = await jwtVerify(Redacted.value(token), keys, {
            issuer,
            audience: clientId,
            algorithms: ["RS256"],
            requiredClaims: ["exp", "sub"],
            currentDate: new Date(now)
          })
          if (!payload.sub?.trim() || (nonce !== undefined && payload.nonce !== nonce))
            throw new Error("Invalid identity")
          if (!validAuthorizedParty(payload, clientId)) throw new Error("Invalid authorized party")
          return payload.sub
        },
        catch: () => failed("Authentication", "Subscription identity validation failed")
      }).pipe(
        Effect.timeout(timeoutMillis),
        Effect.catchTag("TimeoutError", () =>
          Effect.fail(failed("Authentication", "Subscription identity validation timed out"))
        )
      )
    })
  }
}
