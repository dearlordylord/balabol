import { Effect, Schema } from "effect"
import { HttpServer } from "effect/http"
import { expect, it } from "vitest"
import { parseConfig, serverLayer } from "../src/bootstrap/index.ts"
import { UsageSnapshot } from "../src/usage/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"

it("serves validated usage on the existing trusted application origin without exposing provider credentials", async () => {
  const fixture = await temporaryDatabase()
  try {
    const config = await Effect.runPromise(parseConfig({ BALABOL_DATABASE: fixture.path, BALABOL_PORT: "0" }))
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const address = yield* HttpServer.addressFormattedWith(Effect.succeed)
          const response = yield* Effect.tryPromise(() => fetch(`${address}/usage`))
          expect(response.status).toBe(200)
          const data = yield* Effect.tryPromise((): Promise<unknown> => response.json())
          const value = yield* Schema.decodeUnknownEffect(UsageSnapshot)(data)
          expect(value.ledger).toEqual({ since: null, degraded: false, totals: [], recent: [] })
          expect(value.speech.status).toBe("notConfigured")
          const forbidden = yield* Effect.tryPromise(() =>
            fetch(`${address}/usage`, { headers: { "sec-fetch-site": "cross-site" } })
          )
          expect(forbidden.status).toBe(403)
        })
      ).pipe(Effect.provide(serverLayer(config)))
    )
  } finally {
    await fixture.close()
  }
})
