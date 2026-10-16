import { Effect, Layer, Redacted } from "effect"
import { subscriptionAnswerLayer } from "../src/answer-generation/index.ts"
import { SqliteMemoryStorage } from "../src/memory/index.ts"
import { sqliteKnowledgeLayer } from "../src/personal-knowledge/index.ts"
import { Subscription, subscriptionToolInferenceLayer } from "../src/subscription/index.ts"
import type { ToolInferenceTransport } from "../src/subscription/index.ts"
const subscription = Layer.succeed(Subscription, {
  accessToken: () => Effect.succeed(Redacted.make("fixture")),
  begin: () => Effect.die("unused"),
  complete: () => Effect.die("unused"),
  status: () => Effect.succeed({ kind: "Disconnected" }),
  models: () => Effect.succeed([]),
  disconnect: () => Effect.succeed({ revocation: "NotNeeded" })
})
export const knowledgeAnswerLayer = (transport: ToolInferenceTransport) =>
  subscriptionAnswerLayer().pipe(
    Layer.provide(
      Layer.unwrap(
        Effect.gen(function* () {
          const resource = yield* SqliteMemoryStorage
          return sqliteKnowledgeLayer(resource.storage.database)
        })
      )
    ),
    Layer.provide(subscriptionToolInferenceLayer(transport).pipe(Layer.provide(subscription)))
  )
