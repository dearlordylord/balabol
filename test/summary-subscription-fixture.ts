import { Effect, Layer, Redacted } from "effect"
import { Subscription, subscriptionInferenceLayer } from "../src/subscription/index.ts"
import type { InferenceTransport } from "../src/subscription/index.ts"
import { subscriptionSummaryLayer } from "../src/summary-generation/index.ts"
export const summaryFrame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
export const summaryResponse = (text = "Retained synthetic memory."): Response =>
  new Response(
    summaryFrame({ type: "response.output_text.delta", delta: text }) +
      summaryFrame({ type: "response.completed", response: { status: "completed" } })
  )
export const realSummaryFixture = (transport: InferenceTransport) =>
  subscriptionSummaryLayer.pipe(
    Layer.provide(subscriptionInferenceLayer(transport)),
    Layer.provide(
      Layer.succeed(Subscription, {
        accessToken: () => Effect.succeed(Redacted.make("fixture")),
        begin: () => Effect.die("unused"),
        complete: () => Effect.die("unused"),
        status: () => Effect.succeed({ kind: "Disconnected" }),
        models: () => Effect.succeed([]),
        disconnect: () => Effect.succeed({ revocation: "NotNeeded" })
      })
    )
  )
