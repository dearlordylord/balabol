import { Context, Effect, Layer } from "effect"
import { randomUUID } from "node:crypto"
import { connection } from "./connection.ts"
import type { Redacted } from "effect"
import type { ConnectionStatus, DisconnectOutcome, SubscriptionFailed } from "./model.ts"
import type { SubscriptionPorts } from "./ports.ts"
import { livePorts } from "./protocol.ts"
import { protectedStore } from "./store.ts"
export { ConnectionStatus, DisconnectOutcome, SubscriptionFailed } from "./model.ts"
export { subscriptionHttpRequest } from "./protocol.ts"
export { subscriptionIdentityVerifier } from "./identity.ts"
export type { PersistentState } from "./model.ts"
export type { SubscriptionPorts } from "./ports.ts"
/** Owns one app-specific connection, OAuth attempts and rotating credentials. Tokens never cross HTTP/UI boundaries. */
export class Subscription extends Context.Service<
  Subscription,
  {
    readonly begin: (redirectUri: string) => Effect.Effect<{ readonly authorizationUrl: string }, SubscriptionFailed>
    readonly complete: (callbackUrl: string) => Effect.Effect<ConnectionStatus, SubscriptionFailed>
    readonly status: () => Effect.Effect<ConnectionStatus, SubscriptionFailed>
    readonly accessToken: () => Effect.Effect<Redacted.Redacted<string>, SubscriptionFailed>
    readonly models: () => Effect.Effect<readonly string[], SubscriptionFailed>
    readonly disconnect: () => Effect.Effect<DisconnectOutcome, SubscriptionFailed>
  }
>()("balabol/subscription") {}
const make = (ports: SubscriptionPorts) =>
  Effect.gen(function* () {
    const state = yield* ports.load()
    return Subscription.of(connection(state, ports))
  })
/** Fixture seam supplies storage, transport, identity validation and entropy; Effect Clock supplies time. */
export const subscriptionLayerWith = (ports: SubscriptionPorts) => Layer.effect(Subscription, make(ports))
/** The scoped layer holds an exclusive credential-writer lease until all dependent work has ended. */
export const subscriptionLayer = (directory: string) =>
  Layer.effect(
    Subscription,
    Effect.gen(function* () {
      const store = yield* protectedStore(directory, () => `urn:uuid:${randomUUID()}`)
      return yield* make({ ...livePorts(), ...store })
    })
  )
