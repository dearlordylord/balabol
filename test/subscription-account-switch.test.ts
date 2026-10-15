import { Effect } from "effect"
import { expect, it } from "vitest"
import { Subscription, subscriptionLayerWith } from "../src/subscription/index.ts"
import { authorize, fixture } from "./subscription-fixture.ts"
it("explicit account change forgets the registration and admits a fresh account on the same host", async () => {
  const { ports } = fixture()
  let subject = "first-account"
  const layer = subscriptionLayerWith({ ...ports, verifyIdentity: () => Effect.sync(() => subject) })
  let host: string | null = null
  await Effect.runPromise(
    Effect.gen(function* () {
      const subscription = yield* Subscription
      yield* authorize(subscription)
      const before = yield* subscription.begin("http://127.0.0.1:12345/auth/callback")
      host = new URL(before.authorizationUrl).searchParams.get("ext_agent_host_id")
      yield* subscription.disconnect("ChangeAccount")
      expect(yield* subscription.status()).toEqual({ kind: "Disconnected" })
      expect((yield* Effect.result(subscription.accessToken()))._tag).toBe("Failure")
    }).pipe(Effect.provide(layer))
  )
  subject = "second-account"
  await Effect.runPromise(
    Effect.gen(function* () {
      const subscription = yield* Subscription
      const next = yield* subscription.begin("http://127.0.0.1:12345/auth/callback")
      const url = new URL(next.authorizationUrl)
      expect(url.searchParams.get("client_id")).toBe("dynamic_agent_client")
      expect(url.searchParams.get("ext_agent_host_id")).toBe(host)
      const callback = `http://127.0.0.1:12345/auth/callback?state=${url.searchParams.get("state")}&code=new-code&client_id=second-issued-client`
      expect((yield* subscription.complete(callback)).kind).toBe("Connected")
    }).pipe(Effect.provide(layer))
  )
})
it("explicit account change invalidates the pending callback and its unverified issued client", async () => {
  const { ports } = fixture()
  await Effect.runPromise(
    Effect.gen(function* () {
      const subscription = yield* Subscription
      const first = yield* subscription.begin("http://127.0.0.1:12345/auth/callback")
      const state = new URL(first.authorizationUrl).searchParams.get("state")
      const stale = `http://127.0.0.1:12345/auth/callback?state=${state}&code=old-code&client_id=old-issued-client`
      yield* subscription.disconnect("ChangeAccount")
      expect((yield* Effect.result(subscription.complete(stale)))._tag).toBe("Failure")
      const next = yield* subscription.begin("http://127.0.0.1:12345/auth/callback")
      expect(new URL(next.authorizationUrl).searchParams.get("client_id")).toBe("dynamic_agent_client")
    }).pipe(Effect.provide(subscriptionLayerWith(ports)))
  )
})
