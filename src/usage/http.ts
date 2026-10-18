import { withAuditSpan } from "../operation-audit/index.ts"
import { Clock, Effect, Schema } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import type { Redacted } from "effect"
import { LedgerSnapshot, UsageLedger } from "./contracts.ts"
import { sonioxUsage, SpeechSnapshot, type UsageFetch } from "./soniox.ts"

export const UsageSnapshot = Schema.Struct({ ledger: LedgerSnapshot, speech: SpeechSnapshot })
export const usageRoutes = (key?: Redacted.Redacted<string>, fetcher?: UsageFetch) =>
  HttpRouter.use(
    Effect.fn(function* (router) {
      const ledger = yield* UsageLedger
      yield* router.add(
        "GET",
        "/usage",
        Effect.gen(function* () {
          const saved = yield* ledger.read.pipe(withAuditSpan("usage.read"))
          const speech = yield* sonioxUsage(key, yield* Clock.currentTimeMillis, fetcher)
          return yield* HttpServerResponse.schemaJson(UsageSnapshot)({ ledger: saved, speech })
        }).pipe(Effect.catchTag("UsageUnavailable", () => Effect.succeed(HttpServerResponse.empty({ status: 503 }))))
      )
    })
  )
