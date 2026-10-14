import { expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { trustedControlRoutes } from "../src/bootstrap/control-access.ts"
import { parseConfig } from "../src/bootstrap/index.ts"

it.effect("trusted proxy routes reject missing or different owners without local fallback", () =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        trustedControlRoutes(
          HttpRouter.add("GET", "/probe", HttpServerResponse.text("private")),
          "owner@example.invalid"
        ),
        { disableLogger: true }
      )
    ),
    ({ handler }) =>
      Effect.gen(function* () {
        for (const headers of [{}, { "tailscale-user-login": "other@example.invalid" }]) {
          const response = yield* Effect.promise(() =>
            handler(new Request("http://localhost/tailnet/probe", { headers }))
          )
          expect(response.status).toBe(403)
        }
        const allowed = yield* Effect.promise(() =>
          handler(
            new Request("http://localhost/tailnet/probe", {
              headers: { "tailscale-user-login": "owner@example.invalid" }
            })
          )
        )
        expect(yield* Effect.promise(() => allowed.text())).toBe("private")
        const local = yield* Effect.promise(() => handler(new Request("http://localhost/probe")))
        expect(yield* Effect.promise(() => local.text())).toBe("private")
        const crossSite = yield* Effect.promise(() =>
          handler(new Request("http://localhost/probe", { headers: { "sec-fetch-site": "cross-site" } }))
        )
        expect(crossSite.status).toBe(403)
      }),
    ({ dispose }) => Effect.promise(dispose)
  )
)

it.effect("a proxy route without a configured owner stays closed", () =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        trustedControlRoutes(HttpRouter.add("GET", "/probe", HttpServerResponse.text("private")), undefined),
        { disableLogger: true }
      )
    ),
    ({ handler }) =>
      Effect.gen(function* () {
        const response = yield* Effect.promise(() =>
          handler(
            new Request("http://localhost/tailnet/probe", {
              headers: { "tailscale-user-login": "owner@example.invalid" }
            })
          )
        )
        expect(response.status).toBe(403)
      }),
    ({ dispose }) => Effect.promise(dispose)
  )
)

it.effect("voice startup refuses partial credentials and untrusted external listeners without leaking secrets", () =>
  Effect.gen(function* () {
    const secret = "fixture-only-secret".repeat(3)
    const environment = {
      BALABOL_LIVEKIT_URL: "ws://127.0.0.1:7880",
      BALABOL_LIVEKIT_API_KEY: "fixture-only-key",
      BALABOL_LIVEKIT_API_SECRET: secret
    }
    const external = yield* Effect.flip(parseConfig({ ...environment, BALABOL_HOST: "0.0.0.0" }))
    expect(String(external)).not.toContain(secret)
    const partial = yield* Effect.flip(parseConfig({ BALABOL_LIVEKIT_API_KEY: "fixture-only-key" }))
    expect(partial._tag).toBe("SchemaError")
    const valid = yield* parseConfig(environment)
    expect(valid.voice?.mediaUrl).toBe("ws://127.0.0.1:7880")
  })
)
