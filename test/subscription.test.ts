import { Effect, Redacted } from "effect"
import { expect, it } from "vitest"
import { Subscription, subscriptionLayerWith } from "../src/subscription/index.ts"
import { authorize, fixture } from "./subscription-fixture.ts"

it("registers Balabol and completes a one-use PKCE sign-in without exposing secrets", async () => {
  const { ports, requests } = fixture()
  await Effect.runPromise(
    Effect.gen(function* () {
      const subscription = yield* Subscription
      expect(yield* subscription.status()).toEqual({ kind: "Disconnected" })
      const { authorizationUrl } = yield* subscription.begin("http://127.0.0.1:12345/auth/callback")
      const url = new URL(authorizationUrl)
      expect(url.searchParams.get("client_id")).toBe("dynamic_agent_client")
      expect(url.searchParams.get("agent_name_hint")).toBe("Balabol")
      expect(url.searchParams.get("code_challenge_method")).toBe("S256")
      const callback = `http://127.0.0.1:12345/auth/callback?state=${url.searchParams.get("state")}&code=fixture-code&client_id=issued-client`
      expect((yield* subscription.complete(callback)).kind).toBe("Connected")
      expect(Redacted.value(yield* subscription.accessToken())).toBe("fixture-access")
      expect((yield* Effect.result(subscription.complete(callback)))._tag).toBe("Failure")
      expect(requests).toHaveLength(1)
      expect(requests[0]).toContain("client_id=issued-client")
      expect(requests[0]).toContain("code_verifier=")
    }).pipe(Effect.provide(subscriptionLayerWith(ports)))
  )
})
it("rejects a mismatched callback without consuming the valid attempt", async () => {
  const { ports } = fixture()
  await Effect.runPromise(
    Effect.gen(function* () {
      const subscription = yield* Subscription
      const { authorizationUrl } = yield* subscription.begin("http://127.0.0.1:12345/auth/callback")
      const state = new URL(authorizationUrl).searchParams.get("state")
      const rejected = yield* Effect.result(
        subscription.complete("http://127.0.0.1:12345/auth/callback?state=attacker&code=wrong&client_id=other")
      )
      expect(rejected._tag).toBe("Failure")
      expect(
        (yield* subscription.complete(
          `http://127.0.0.1:12345/auth/callback?state=${state}&code=fixture&client_id=issued`
        )).kind
      ).toBe("Connected")
    }).pipe(Effect.provide(subscriptionLayerWith(ports)))
  )
})
it("rejects ambiguous callback parameters", async () => {
  const { ports } = fixture()
  await Effect.runPromise(
    Effect.gen(function* () {
      const subscription = yield* Subscription
      const { authorizationUrl } = yield* subscription.begin("http://127.0.0.1:12345/auth/callback")
      const state = new URL(authorizationUrl).searchParams.get("state")
      const result = yield* Effect.result(
        subscription.complete(
          `http://127.0.0.1:12345/auth/callback?state=${state}&code=fixture&code=another&client_id=issued`
        )
      )
      expect(result._tag).toBe("Failure")
    }).pipe(Effect.provide(subscriptionLayerWith(ports)))
  )
})
for (const redirect of [
  "https://127.0.0.1/auth/callback",
  "http://example.com/auth/callback",
  "http://user@127.0.0.1/auth/callback",
  "http://127.0.0.1/auth/callback?query=1"
])
  it(`rejects unsafe callback origin ${redirect}`, async () => {
    const { ports } = fixture()
    await Effect.runPromise(
      Effect.gen(function* () {
        const subscription = yield* Subscription
        expect((yield* Effect.result(subscription.begin(redirect)))._tag).toBe("Failure")
      }).pipe(Effect.provide(subscriptionLayerWith(ports)))
    )
  })
it("rejects missing or unissued registration identifiers before token exchange", async () => {
  for (const client of ["", "&client_id=dynamic_agent_client"]) {
    const { ports, requests } = fixture()
    await Effect.runPromise(
      Effect.gen(function* () {
        const subscription = yield* Subscription
        const { authorizationUrl } = yield* subscription.begin("http://127.0.0.1:12345/auth/callback")
        const state = new URL(authorizationUrl).searchParams.get("state")
        const result = yield* Effect.result(
          subscription.complete(`http://127.0.0.1:12345/auth/callback?state=${state}&code=fixture${client}`)
        )
        expect(result._tag).toBe("Failure")
        expect(requests).toHaveLength(0)
      }).pipe(Effect.provide(subscriptionLayerWith(ports)))
    )
  }
})
it("rejects replacement of the registered client without exchanging the code", async () => {
  const { ports, requests } = fixture()
  await Effect.runPromise(
    Effect.gen(function* () {
      const subscription = yield* Subscription
      yield* authorize(subscription)
      const { authorizationUrl } = yield* subscription.begin("http://127.0.0.1:12345/auth/callback")
      const state = new URL(authorizationUrl).searchParams.get("state")
      const result = yield* Effect.result(
        subscription.complete(
          `http://127.0.0.1:12345/auth/callback?state=${state}&code=fixture&client_id=attacker-client`
        )
      )
      expect(result._tag).toBe("Failure")
      expect(requests).toHaveLength(1)
      expect((yield* subscription.status()).kind).toBe("Connected")
    }).pipe(Effect.provide(subscriptionLayerWith(ports)))
  )
})
