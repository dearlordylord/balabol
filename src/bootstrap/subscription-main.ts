import { spawn } from "node:child_process"
import { NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import { HttpServer } from "effect/http"
import { parseSubscriptionSettings, subscriptionAdminLayer } from "./subscription-admin.ts"

Effect.gen(function* () {
  const settings = yield* parseSubscriptionSettings(process.env)
  const application = subscriptionAdminLayer(settings.directory, settings.port)
  return yield* Effect.gen(function* () {
    const address = yield* HttpServer.addressFormattedWith(Effect.succeed)
    yield* Effect.logInfo(
      `Balabol subscription setup: ${address}. The connection process owns the local credential store while running.`
    )
    yield* Effect.tryPromise(
      () =>
        new Promise<void>((resolve, reject) => {
          const browser = spawn("open", [address], { stdio: "ignore" })
          browser.once("error", reject)
          browser.once("exit", (code) =>
            code === 0 ? resolve() : reject(new Error("Could not open subscription setup"))
          )
        })
    )
    return yield* Effect.never
  }).pipe(Effect.provide(application))
}).pipe(NodeRuntime.runMain)
