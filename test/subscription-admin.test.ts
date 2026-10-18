import { mkdtemp, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { expect, it } from "vitest"
import {
  SubscriptionAdminOrigin,
  parseSubscriptionSettings,
  subscriptionAdminLayer,
  subscriptionAdminRoutes
} from "../src/bootstrap/subscription-admin.ts"
import { Subscription } from "../src/subscription/index.ts"

const localOrigin = "http://127.0.0.1:8788"

it("serves disconnected setup on an actual loopback socket without opening a browser", async () => {
  const directory = await mkdtemp(join(tmpdir(), "balabol-subscription-admin-"))
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const address = yield* HttpServer.addressFormattedWith(Effect.succeed)
          const page = yield* Effect.tryPromise(() => fetch(address))
          expect(page.headers.get("referrer-policy")).toBe("same-origin")
          const result = yield* Effect.tryPromise(() => fetch(`${address}/status`))
          expect(result.status).toBe(200)
          expect(yield* Effect.tryPromise(() => result.json())).toEqual({ kind: "Disconnected" })
          const forbidden = yield* Effect.tryPromise(() =>
            fetch(`${address}/connect`, { method: "POST", headers: { host: "evil.invalid" } })
          )
          expect(forbidden.status).toBe(403)
        })
      ).pipe(Effect.provide(subscriptionAdminLayer(directory, 0)))
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it("validates setup configuration before binding a loopback listener", async () => {
  expect(await Effect.runPromise(parseSubscriptionSettings({}))).toEqual({
    directory: join(homedir(), ".local", "share", "balabol", "subscription"),
    port: 8788
  })
  expect(
    await Effect.runPromise(
      parseSubscriptionSettings({ BALABOL_SUBSCRIPTION_DIRECTORY: "/tmp/custom", BALABOL_SUBSCRIPTION_PORT: "0" })
    )
  ).toEqual({ directory: "/tmp/custom", port: 0 })
  expect(
    (await Effect.runPromise(Effect.flip(parseSubscriptionSettings({ BALABOL_SUBSCRIPTION_PORT: "invalid" }))))._tag
  ).toBe("SchemaError")
})

it("keeps subscription consent on loopback and rejects browser cross-site mutations", async () => {
  const callbacks: string[] = []
  let disconnected = false
  const disconnectModes: unknown[] = []
  let connected = false
  const service = Layer.succeed(Subscription, {
    begin: (uri) => {
      callbacks.push(uri)
      return Effect.succeed({ authorizationUrl: "https://auth.openai.com/fixture" })
    },
    complete: () =>
      Effect.sync(() => {
        connected = true
        return { kind: "Connected", expiresAt: 1000 }
      }),
    status: () => Effect.succeed(connected ? { kind: "Connected", expiresAt: 1000 } : { kind: "Disconnected" }),
    models: () => Effect.succeed([]),
    accessToken: () => Effect.die("Admin must never request an inference token"),
    disconnect: (mode) =>
      Effect.sync(() => {
        disconnectModes.push(mode)
        disconnected = true
        connected = false
        return { revocation: "Unconfirmed" }
      })
  })
  const web = HttpRouter.toWebHandler(
    subscriptionAdminRoutes.pipe(
      Layer.provideMerge(service),
      Layer.provideMerge(Layer.succeed(SubscriptionAdminOrigin, localOrigin))
    ),
    { disableLogger: true }
  )
  const request = (path: string, init?: RequestInit) => web.handler(new Request(`http://127.0.0.1:8788${path}`, init))
  try {
    const page = await request("/")
    expect(page.status).toBe(200)
    expect(await page.text()).toContain("Continue with ChatGPT")
    expect(await (await request("/connected")).text()).not.toContain("Setup is complete")
    for (const headers of [{ "sec-fetch-site": "cross-site" }, { origin: "https://evil.invalid" }]) {
      expect((await request("/connect", { method: "POST", headers })).status).toBe(403)
    }
    const rebinding = await web.handler(new Request("http://evil.invalid/connect", { method: "POST" }))
    expect(rebinding.status).toBe(403)
    expect(callbacks).toEqual([])
    const start = await request("/connect", { method: "POST", headers: { origin: "http://127.0.0.1:8788" } })
    expect(start.status).toBe(303)
    expect(start.headers.get("location")).toBe("https://auth.openai.com/fixture")
    expect(start.headers.get("cache-control")).toBe("no-store")
    expect(start.headers.get("content-security-policy")).toContain("https://auth.openai.com")
    expect(callbacks).toEqual(["http://127.0.0.1:8788/callback"])
    const callback = await request("/callback?code=fixture&state=fixture", {
      headers: { "sec-fetch-site": "cross-site" }
    })
    expect(callback.status).toBe(303)
    expect(callback.headers.get("location")).toBe("/connected")
    const connectedPage = await (await request("/connected")).text()
    expect(connectedPage).toContain("Setup is complete")
    expect(connectedPage).not.toContain("Continue with ChatGPT")
    const switched = await request("/switch-account", { method: "POST" })
    expect(switched.status).toBe(303)
    expect(disconnectModes).toEqual(["ChangeAccount"])
    const disconnect = await request("/disconnect", { method: "POST" })
    expect(disconnect.status).toBe(200)
    expect(await disconnect.text()).toContain("We could not confirm")
    expect(disconnected).toBe(true)
    const status = await request("/status")
    expect(await status.json()).toEqual({ kind: "Disconnected" })
    const wrongPort = await request("/connect", { method: "POST", headers: { host: "127.0.0.1:9999" } })
    expect(wrongPort.status).toBe(403)
  } finally {
    await web.dispose()
  }
})
