import type { Effect, Redacted } from "effect"
import { Context } from "effect"
import type { ConnectionStatus, DisconnectMode, DisconnectOutcome, SubscriptionFailed } from "./model.ts"
/** Owns one app-specific connection, OAuth attempts and rotating credentials. Tokens never cross HTTP/UI boundaries. */
export class Subscription extends Context.Service<
  Subscription,
  {
    readonly begin: (redirectUri: string) => Effect.Effect<{ readonly authorizationUrl: string }, SubscriptionFailed>
    readonly complete: (callbackUrl: string) => Effect.Effect<ConnectionStatus, SubscriptionFailed>
    readonly status: () => Effect.Effect<ConnectionStatus, SubscriptionFailed>
    readonly accessToken: () => Effect.Effect<Redacted.Redacted<string>, SubscriptionFailed>
    readonly models: () => Effect.Effect<readonly string[], SubscriptionFailed>
    readonly disconnect: (mode?: DisconnectMode) => Effect.Effect<DisconnectOutcome, SubscriptionFailed>
  }
>()("balabol/subscription") {}
