import { Subscription } from "./service.ts"
import { Effect, Layer } from "effect"
import { randomUUID } from "node:crypto"
import { connection } from "./connection.ts"
import type { SubscriptionPorts } from "./ports.ts"
import { livePorts } from "./protocol.ts"
import { protectedStore } from "./store.ts"
export { Subscription } from "./service.ts"
export { SubscriptionInference, InferenceRequest, InferenceEvent, InferenceFailed } from "./inference-model.ts"
export { subscriptionInferenceLayer, inferenceHttpTransport } from "./inference.ts"
export type { InferenceTransport } from "./inference.ts"
export { ConnectionStatus, DisconnectMode, DisconnectOutcome, SubscriptionFailed } from "./model.ts"
export { subscriptionHttpRequest } from "./protocol.ts"
export { subscriptionIdentityVerifier } from "./identity.ts"
export type { PersistentState } from "./model.ts"
export type { SubscriptionPorts } from "./ports.ts"
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
export {
  SubscriptionToolInference,
  ToolInferenceRequest,
  ToolInferenceEvent,
  ToolInput,
  ToolDefinition
} from "./tool-model.ts"
export { ReasoningItem, ToolReplay } from "./tool-model.ts"
export { subscriptionToolInferenceLayer, toolInferenceHttpTransport } from "./tool-inference.ts"
export type { ToolInferenceTransport } from "./tool-inference.ts"
