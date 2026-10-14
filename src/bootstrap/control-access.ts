import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"

const browserRequestAllowed = (headers: Readonly<Record<string, string>>) => headers["sec-fetch-site"] !== "cross-site"
const authorization = (owner: string | undefined, proxy: boolean) =>
  HttpRouter.middleware((handler) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (!browserRequestAllowed(request.headers)) return HttpServerResponse.empty({ status: 403 })
      if (proxy && (owner === undefined || request.headers["tailscale-user-login"] !== owner))
        return HttpServerResponse.empty({ status: 403 })
      return yield* handler
    })
  )

/** Loopback is local development; Serve targets /tailnet, where identity is mandatory. */
export const trustedControlRoutes = <A, E, R>(routes: Layer.Layer<A, E, R>, owner: string | undefined) =>
  Layer.merge(
    routes.pipe(Layer.provide(authorization(undefined, false).layer)),
    routes.pipe(
      Layer.fresh,
      Layer.updateService(HttpRouter.HttpRouter, (router) => router.prefixed("/tailnet")),
      Layer.provide(authorization(owner, true).layer)
    )
  )
