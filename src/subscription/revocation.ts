import { Effect, Redacted, Schema } from "effect"
import type { Credential, DisconnectOutcome } from "./model.ts"
import { failed, issuer } from "./model.ts"
import type { SubscriptionPorts } from "./ports.ts"
const retryDelayMillis = 250
const successStatus = 200
const serverErrorStatus = 500
const maximumEndpointLength = 2048
const Metadata = Schema.Struct({ revocation_endpoint: Schema.String.check(Schema.isMaxLength(maximumEndpointLength)) })
const trustedEndpoint = (value: string) =>
  Effect.try({
    try: () => {
      const url = new URL(value)
      if (url.origin !== issuer || url.username || url.password || url.search || url.hash)
        throw new Error("Untrusted revocation endpoint")
      return url.href
    },
    catch: () => failed("Provider", "Invalid subscription revocation endpoint")
  })
/** Sign-out is locally final even if the bounded remote revocation cannot be confirmed. */
export const revoke = (
  credential: Credential | undefined,
  ports: SubscriptionPorts
): Effect.Effect<DisconnectOutcome> => {
  if (credential === undefined) return Effect.succeed({ revocation: "NotNeeded" })
  return Effect.gen(function* revokeSession() {
    const discovery = yield* ports.request(`${issuer}/.well-known/openid-configuration`, { method: "GET", headers: {} })
    if (discovery.status !== successStatus) return { revocation: "Unconfirmed" as const }
    const metadata = yield* Schema.decodeUnknownEffect(Metadata)(discovery.body)
    const endpoint = yield* trustedEndpoint(metadata.revocation_endpoint)
    const request = ports.request(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Balabol" },
      body: new URLSearchParams({
        token: Redacted.value(credential.refreshToken),
        token_type_hint: "refresh_token",
        client_id: credential.clientId
      }).toString(),
      responseMode: "empty"
    })
    const first = yield* Effect.result(request)
    if (first._tag === "Success" && first.success.status === successStatus) return { revocation: "Confirmed" as const }
    const retry = first._tag === "Failure" || first.success.status >= serverErrorStatus
    if (!retry) return { revocation: "Unconfirmed" as const }
    yield* Effect.sleep(retryDelayMillis)
    const second = yield* request
    return { revocation: second.status === successStatus ? ("Confirmed" as const) : ("Unconfirmed" as const) }
  }).pipe(Effect.catch(() => Effect.succeed({ revocation: "Unconfirmed" as const })))
}
