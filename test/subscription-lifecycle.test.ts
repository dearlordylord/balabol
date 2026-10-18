import { Deferred, Effect, Fiber, Redacted } from "effect"
import { expect, it } from "vitest"
import { Subscription, subscriptionLayerWith, SubscriptionFailed } from "../src/subscription/index.ts"
import { authorize, fixture } from "./subscription-fixture.ts"
it("serializes rotating refresh across concurrent requests", async () => {
  const { ports, tokens } = fixture()
  let exchanges = 0
  let refreshes = 0
  const layer = subscriptionLayerWith({
    ...ports,
    request: (_url, init) =>
      Effect.sync(() => {
        if (init.body?.includes("grant_type=refresh_token")) {
          refreshes++
          expect(init.body).toContain("refresh_token=fixture-refresh")
          return { status: 200, body: { ...tokens, access_token: "refreshed", refresh_token: "rotated" } }
        }
        exchanges++
        return { status: 200, body: { ...tokens, expires_in: 1 } }
      })
  })
  await Effect.runPromise(
    Effect.gen(function* () {
      const subscription = yield* Subscription
      yield* authorize(subscription)
      const values = yield* Effect.all([subscription.accessToken(), subscription.accessToken()], {
        concurrency: "unbounded"
      })
      expect(values.map(Redacted.value)).toEqual(["refreshed", "refreshed"])
      expect(exchanges).toBe(1)
      expect(refreshes).toBe(1)
    }).pipe(Effect.provide(layer))
  )
})
it("does not resurrect a connection when disconnect follows an in-flight refresh", async () => {
  const { ports, tokens } = fixture()
  await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const layer = subscriptionLayerWith({
        ...ports,
        request: (_url, init) => {
          if (!init.body?.includes("grant_type=refresh_token"))
            return Effect.succeed({ status: 200, body: { ...tokens, expires_in: 1 } })
          return Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as({ status: 200, body: tokens })
          )
        }
      })
      yield* Effect.gen(function* () {
        const subscription = yield* Subscription
        yield* authorize(subscription)
        const refresh = yield* subscription.accessToken().pipe(Effect.forkChild)
        yield* Deferred.await(started)
        const disconnect = yield* subscription.disconnect().pipe(Effect.forkChild)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(refresh)
        yield* Fiber.join(disconnect)
        expect(yield* subscription.status()).toEqual({ kind: "Disconnected" })
        expect((yield* Effect.result(subscription.accessToken()))._tag).toBe("Failure")
      }).pipe(Effect.provide(layer))
    })
  )
})
it("rejects invalid identity and missing scope without saving an authenticated connection", async () => {
  for (const scope of ["chatgpt.tokens.use.direct", "openid"]) {
    const { ports, tokens } = fixture()
    const layer = subscriptionLayerWith({
      ...ports,
      verifyIdentity: () => Effect.fail(new SubscriptionFailed({ kind: "Authentication", message: "Invalid nonce" })),
      request: () => Effect.succeed({ status: 200, body: { ...tokens, scope } })
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const subscription = yield* Subscription
        expect((yield* Effect.result(authorize(subscription)))._tag).toBe("Failure")
        expect(yield* subscription.status()).toEqual({ kind: "Disconnected" })
      }).pipe(Effect.provide(layer))
    )
  }
})
it("refuses account changes even after local disconnect", async () => {
  const { ports } = fixture()
  let subject = "first-account"
  await Effect.runPromise(
    Effect.gen(function* () {
      const subscription = yield* Subscription
      yield* authorize(subscription)
      subject = "different-account"
      expect((yield* Effect.result(authorize(subscription)))._tag).toBe("Failure")
      expect((yield* subscription.status()).kind).toBe("Connected")
      yield* subscription.disconnect()
      expect((yield* Effect.result(authorize(subscription)))._tag).toBe("Failure")
      expect((yield* subscription.status()).kind).toBe("Disconnected")
    }).pipe(Effect.provide(subscriptionLayerWith({ ...ports, verifyIdentity: () => Effect.sync(() => subject) })))
  )
})
it("restores the same app registration and credentials after restart", async () => {
  const { ports } = fixture()
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* authorize(yield* Subscription)
    }).pipe(Effect.provide(subscriptionLayerWith(ports)))
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const subscription = yield* Subscription
      expect(Redacted.value(yield* subscription.accessToken())).toBe("fixture-access")
      const { authorizationUrl } = yield* subscription.begin("http://127.0.0.1:12345/auth/callback")
      expect(new URL(authorizationUrl).searchParams.get("client_id")).toBe("issued")
    }).pipe(Effect.provide(subscriptionLayerWith(ports)))
  )
})
it("retains the issued registration without credentials after disconnect and restart", async () => {
  const { ports } = fixture()
  await Effect.runPromise(
    Effect.gen(function* () {
      const subscription = yield* Subscription
      yield* authorize(subscription)
      yield* subscription.disconnect()
      expect((yield* Effect.result(subscription.accessToken()))._tag).toBe("Failure")
    }).pipe(Effect.provide(subscriptionLayerWith(ports)))
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const subscription = yield* Subscription
      expect(yield* subscription.status()).toEqual({ kind: "Disconnected" })
      const { authorizationUrl } = yield* subscription.begin("http://127.0.0.1:12345/auth/callback")
      expect(new URL(authorizationUrl).searchParams.get("client_id")).toBe("issued")
    }).pipe(Effect.provide(subscriptionLayerWith(ports)))
  )
})
it("preserves a newly issued client after failed exchange and restart", async () => {
  const { ports } = fixture()
  const failedExchange = subscriptionLayerWith({ ...ports, request: () => Effect.succeed({ status: 503, body: null }) })
  await Effect.runPromise(
    Effect.gen(function* () {
      const subscription = yield* Subscription
      expect((yield* Effect.result(authorize(subscription)))._tag).toBe("Failure")
      expect(yield* subscription.status()).toEqual({ kind: "Disconnected" })
    }).pipe(Effect.provide(failedExchange))
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const subscription = yield* Subscription
      const { authorizationUrl } = yield* subscription.begin("http://127.0.0.1:12345/auth/callback")
      expect(new URL(authorizationUrl).searchParams.get("client_id")).toBe("issued")
    }).pipe(Effect.provide(subscriptionLayerWith(ports)))
  )
})
it("keeps parsed token values redacted across identity and persistence ports", async () => {
  const { ports } = fixture()
  let saved = false
  let validated = false
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* authorize(yield* Subscription)
    }).pipe(
      Effect.provide(
        subscriptionLayerWith({
          ...ports,
          verifyIdentity: (token) =>
            Effect.sync(() => {
              validated = true
              expect(Redacted.isRedacted(token)).toBe(true)
              expect(JSON.stringify(token)).not.toContain("fixture-id")
              return "fixture-subject"
            }),
          save: (state) =>
            Effect.gen(function* () {
              if (state.credential !== undefined) {
                saved = true
                expect(Redacted.isRedacted(state.credential.accessToken)).toBe(true)
                expect(Redacted.isRedacted(state.credential.refreshToken)).toBe(true)
                expect(JSON.stringify(state)).not.toContain("fixture-access")
                expect(JSON.stringify(state)).not.toContain("fixture-refresh")
              }
              yield* ports.save(state)
            })
        })
      )
    )
  )
  expect(saved && validated).toBe(true)
})

it("reports a rejected expired-token refresh as authentication without provider details", async () => {
  const { ports, tokens } = fixture()
  const layer = subscriptionLayerWith({
    ...ports,
    request: (_url, init) =>
      Effect.succeed(
        init.body?.includes("grant_type=refresh_token")
          ? { status: 400, body: { error: "private refresh details" } }
          : { status: 200, body: { ...tokens, expires_in: 1 } }
      )
  })
  await Effect.runPromise(
    Effect.gen(function* () {
      const subscription = yield* Subscription
      yield* authorize(subscription)
      const result = yield* subscription.accessToken().pipe(Effect.result)
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { kind: "Authentication", message: expect.stringContaining("switch account") }
      })
      expect(JSON.stringify(result)).not.toContain("private refresh details")
    }).pipe(Effect.provide(layer))
  )
})
