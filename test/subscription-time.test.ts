import { it } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vitest"
import { Subscription, subscriptionLayerWith } from "../src/subscription/index.ts"
import { fixture } from "./subscription-fixture.ts"
it.effect("expires an abandoned sign-in and does not exchange its authorization code", () => {
  const { ports, requests } = fixture()
  return Effect.gen(function* () {
    const subscription = yield* Subscription
    const { authorizationUrl } = yield* subscription.begin("http://127.0.0.1:12345/auth/callback")
    const state = new URL(authorizationUrl).searchParams.get("state")
    yield* TestClock.adjust(600001)
    expect(
      (yield* Effect.result(
        subscription.complete(`http://127.0.0.1:12345/auth/callback?state=${state}&code=fixture&client_id=issued`)
      ))._tag
    ).toBe("Failure")
    expect(requests).toHaveLength(0)
  }).pipe(Effect.provide(subscriptionLayerWith(ports)))
})
