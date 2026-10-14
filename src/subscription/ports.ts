import type { Effect, Redacted } from "effect"
import type { PersistentState, SubscriptionFailed } from "./model.ts"
export interface SubscriptionPorts {
  readonly load: () => Effect.Effect<PersistentState, SubscriptionFailed>
  readonly save: (state: PersistentState) => Effect.Effect<void, SubscriptionFailed>
  readonly random: () => string
  readonly request: (
    url: string,
    init: {
      readonly method: "GET" | "POST"
      readonly headers: Readonly<Record<string, string>>
      readonly body?: string
      readonly responseMode?: "empty"
    }
  ) => Effect.Effect<{ readonly status: number; readonly body: unknown }, SubscriptionFailed>
  readonly verifyIdentity: (
    token: Redacted.Redacted<string>,
    clientId: string,
    nonce?: string
  ) => Effect.Effect<string, SubscriptionFailed>
}
