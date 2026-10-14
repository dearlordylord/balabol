import { Effect } from "effect"
import type { PersistentState, SubscriptionPorts } from "../src/subscription/index.ts"
export const fixture = () => {
  let stored: PersistentState = { hostId: "urn:uuid:00000000-0000-4000-8000-000000000000" }
  const requests: string[] = []
  const tokens = {
    access_token: "fixture-access",
    refresh_token: "fixture-refresh",
    id_token: "fixture-id",
    expires_in: 3600,
    scope: "chatgpt.tokens.use.direct"
  }
  const ports: SubscriptionPorts = {
    load: () => Effect.succeed(stored),
    save: (value) =>
      Effect.sync(() => {
        stored = value
      }),
    random: () => "deterministic-fixture-value-ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    verifyIdentity: () => Effect.succeed("fixture-subject"),
    request: (url, init) =>
      Effect.sync(() => {
        requests.push(`${url} ${init.body ?? ""}`)
        return { status: 200, body: tokens }
      })
  }
  return { ports, requests, tokens }
}
export const authorize = (subscription: {
  begin: (url: string) => Effect.Effect<{ readonly authorizationUrl: string }, unknown>
  complete: (url: string) => Effect.Effect<unknown, unknown>
}) =>
  Effect.gen(function* () {
    const { authorizationUrl } = yield* subscription.begin("http://127.0.0.1:12345/auth/callback")
    const state = new URL(authorizationUrl).searchParams.get("state")
    yield* subscription.complete(`http://127.0.0.1:12345/auth/callback?state=${state}&code=fixture&client_id=issued`)
  })
