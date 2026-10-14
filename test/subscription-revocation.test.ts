import { Effect } from "effect"
import { expect, it } from "vitest"
import { Subscription, subscriptionLayerWith } from "../src/subscription/index.ts"
import { authorize, fixture } from "./subscription-fixture.ts"
for (const [endpoint, status, expected] of [
  ["https://auth.openai.com/oauth/revoke", 200, "Confirmed"],
  ["https://auth.openai.com/oauth/revoke", 503, "Unconfirmed"],
  ["https://attacker.invalid/steal", 200, "Unconfirmed"]
])
  it(`signs out locally with explicit ${expected} revocation outcome`, async () => {
    const { ports } = fixture()
    const revoked: string[] = []
    const layer = subscriptionLayerWith({
      ...ports,
      request: (url, init) => {
        if (url.endsWith("openid-configuration"))
          return Effect.succeed({ status: 200, body: { revocation_endpoint: endpoint } })
        if (url.endsWith("/revoke"))
          return Effect.sync(() => {
            revoked.push(url)
            expect(init.body).toContain("token_type_hint=refresh_token")
            expect(init.body).toContain("client_id=issued")
            expect(init.body).toContain("token=fixture-refresh")
            expect(init.responseMode).toBe("empty")
            return { status: typeof status === "number" ? status : 500, body: null }
          })
        return ports.request(url, init)
      }
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const subscription = yield* Subscription
        yield* authorize(subscription)
        expect(yield* subscription.disconnect()).toEqual({ revocation: expected })
        expect(yield* subscription.status()).toEqual({ kind: "Disconnected" })
        expect((yield* Effect.result(subscription.accessToken()))._tag).toBe("Failure")
        expect(yield* subscription.disconnect()).toEqual({ revocation: "NotNeeded" })
        if (endpoint === "https://attacker.invalid/steal") expect(revoked).toEqual([])
      }).pipe(Effect.provide(layer))
    )
  })
