import { Effect } from "effect"
import { expect, it } from "vitest"
import { Subscription, subscriptionLayerWith } from "../src/subscription/index.ts"
import { authorize, fixture } from "./subscription-fixture.ts"
it("returns only listed API-supported subscription model identifiers", async () => {
  const { ports } = fixture()
  const catalog = {
    models: [
      { slug: "fixture-sol", visibility: "list", supported_in_api: true },
      { slug: "hidden", visibility: "hidden", supported_in_api: true },
      { slug: "unsupported", visibility: "list", supported_in_api: false }
    ]
  }
  const layer = subscriptionLayerWith({
    ...ports,
    request: (url, init) =>
      init.method === "GET" ? Effect.succeed({ status: 200, body: catalog }) : ports.request(url, init)
  })
  await Effect.runPromise(
    Effect.gen(function* () {
      const subscription = yield* Subscription
      yield* authorize(subscription)
      expect(yield* subscription.models()).toEqual(["fixture-sol"])
    }).pipe(Effect.provide(layer))
  )
})
it("returns typed catalog failures without echoing provider errors or token material", async () => {
  for (const [status, kind, body] of [
    [401, "Authentication", { error: "fixture-secret" }],
    [429, "Quota", { error: "fixture-secret" }],
    [500, "Provider", { error: "fixture-secret" }],
    [200, "Provider", { data: [{ id: "wrong-catalog" }] }]
  ]) {
    const { ports } = fixture()
    await Effect.runPromise(
      Effect.gen(function* () {
        const subscription = yield* Subscription
        yield* authorize(subscription)
        const result = yield* Effect.result(subscription.models())
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") {
          expect(result.failure.kind).toBe(kind)
          expect(JSON.stringify(result.failure)).not.toContain("fixture-secret")
        }
      }).pipe(
        Effect.provide(
          subscriptionLayerWith({
            ...ports,
            request: (url, init) =>
              init.method === "GET"
                ? Effect.succeed({ status: typeof status === "number" ? status : 500, body })
                : ports.request(url, init)
          })
        )
      )
    )
  }
})
