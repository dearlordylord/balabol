import { createServer } from "node:http"
import { homedir } from "node:os"
import { join } from "node:path"
import { NodeHttpServer } from "@effect/platform-node"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { ConnectionStatus, Subscription, subscriptionLayer } from "../subscription/index.ts"
import type { SubscriptionFailed } from "../subscription/index.ts"

export class SubscriptionAdminOrigin extends Context.Service<SubscriptionAdminOrigin, string>()(
  "balabol/subscription-admin-origin"
) {}

const maximumPort = 65535
const unavailableStatus = 503
const Settings = Schema.Struct({
  directory: Schema.NonEmptyString,
  port: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: maximumPort }))
})
export const parseSubscriptionSettings = (environment: NodeJS.ProcessEnv) =>
  Schema.decodeUnknownEffect(Settings)({
    directory:
      environment.BALABOL_SUBSCRIPTION_DIRECTORY ?? join(homedir(), ".local", "share", "balabol", "subscription"),
    port: Number(environment.BALABOL_SUBSCRIPTION_PORT ?? "8788")
  })

const page = (message: string, connected = false, status = 200) =>
  HttpServerResponse.html(
    `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Balabol subscription</title><style>body{font:18px/1.6 system-ui;max-width:38rem;margin:3rem auto;padding:1rem}button{font:inherit;padding:.5rem 1rem}</style>
<h1>Connect ChatGPT to Balabol</h1><p>${message}</p>
${connected ? '<form method="post" action="/disconnect"><button>Disconnect Balabol</button></form>' : '<form method="post" action="/connect"><button>Continue with ChatGPT</button></form>'}
<p>This connection belongs to Balabol. Your existing Codex login is unchanged.</p>
<p>Connecting does not run AI or spend credits. Balabol must use your subscription only, with paid credits disabled.</p>
<p><a href="https://chatgpt.com/#settings" rel="noreferrer">Open ChatGPT settings</a></p></html>`
  ).pipe(HttpServerResponse.setStatus(status))

const localOnly = (local: string) =>
  HttpRouter.middleware((handler) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const url = new URL(request.originalUrl, local)
      const host = request.headers.host ?? url.host
      const mutation = request.method !== "GET"
      if (host !== new URL(local).host) return HttpServerResponse.empty({ status: 403 })
      if (
        mutation &&
        (request.headers["sec-fetch-site"] === "cross-site" ||
          (request.headers.origin !== undefined && request.headers.origin !== local))
      )
        return HttpServerResponse.empty({ status: 403 })
      return (yield* handler).pipe(
        HttpServerResponse.setHeader("cache-control", "no-store"),
        HttpServerResponse.setHeader("referrer-policy", "same-origin"),
        HttpServerResponse.setHeader(
          "content-security-policy",
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://auth.openai.com; frame-ancestors 'none'"
        ),
        HttpServerResponse.setHeader("x-content-type-options", "nosniff")
      )
    })
  )

const errors = Effect.catchTags({
  SubscriptionFailed: (_error: SubscriptionFailed) =>
    Effect.succeed(page("Connection failed. Continue with ChatGPT to try again.", false, unavailableStatus))
})
const welcome = Effect.gen(function* () {
  const subscription = yield* Subscription
  const connected = (yield* subscription.status()).kind === "Connected"
  return page(
    connected
      ? "ChatGPT connected. Setup is complete. You can close this tab."
      : "Use your existing ChatGPT subscription.",
    connected
  )
})
const status = Effect.gen(function* () {
  const subscription = yield* Subscription
  return yield* HttpServerResponse.schemaJson(ConnectionStatus)(yield* subscription.status())
})
const connect = Effect.gen(function* () {
  const origin = yield* SubscriptionAdminOrigin
  const subscription = yield* Subscription
  const result = yield* subscription.begin(`${origin}/callback`)
  return HttpServerResponse.redirect(result.authorizationUrl, { status: 303 })
})
const callback = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const origin = yield* SubscriptionAdminOrigin
  const subscription = yield* Subscription
  yield* subscription.complete(new URL(request.url, origin).href)
  return HttpServerResponse.redirect("/connected", { status: 303 })
}).pipe(
  Effect.catchTags({
    SubscriptionFailed: (_error: SubscriptionFailed) =>
      Effect.succeed(HttpServerResponse.redirect("/failed", { status: 303 }))
  })
)
const disconnect = Effect.gen(function* () {
  const subscription = yield* Subscription
  const result = yield* subscription.disconnect()
  return page(
    result.revocation === "Unconfirmed"
      ? "Balabol is disconnected on this Mac. We could not confirm that its access was removed from your ChatGPT account."
      : "Balabol is disconnected. Its saved sign-in details have been removed."
  )
})

/** A separate loopback-only owner console; never mounted on iPhone or tailnet routes. */
export const subscriptionAdminRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const local = yield* SubscriptionAdminOrigin
    return HttpRouter.use(
      Effect.fn(function* (router) {
        yield* router.add("GET", "/", welcome.pipe(errors))
        yield* router.add("GET", "/connected", welcome.pipe(errors))
        yield* router.add("GET", "/failed", page("Subscription connection failed. Continue with ChatGPT to retry."))
        yield* router.add("GET", "/status", status.pipe(errors))
        yield* router.add("POST", "/connect", connect.pipe(errors))
        yield* router.add("GET", "/callback", callback.pipe(errors))
        yield* router.add("POST", "/disconnect", disconnect.pipe(errors))
      })
    ).pipe(Layer.provide(localOnly(local).layer))
  })
)

export const subscriptionAdminLayer = (directory: string, port: number) => {
  const server = NodeHttpServer.layer(createServer, { host: "127.0.0.1", port })
  return HttpRouter.serve(subscriptionAdminRoutes, { disableLogger: true }).pipe(
    Layer.provide(
      Layer.effect(SubscriptionAdminOrigin, HttpServer.addressFormattedWith(Effect.succeed)).pipe(Layer.provide(server))
    ),
    Layer.provide(subscriptionLayer(directory)),
    Layer.provideMerge(server)
  )
}
