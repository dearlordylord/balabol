import { Schema } from "effect"
const maximumTokenLength = 32768
const maximumTokenLifetimeSeconds = 86400
const maximumModelNameLength = 200
const maximumModels = 1000
const bounded = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximumTokenLength))
export const ConnectionStatus = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("Disconnected") }),
  Schema.Struct({ kind: Schema.Literal("Connected"), expiresAt: Schema.Number })
])
export type ConnectionStatus = typeof ConnectionStatus.Type
export class SubscriptionFailed extends Schema.TaggedError<SubscriptionFailed>()("SubscriptionFailed", {
  kind: Schema.Literals(["Authentication", "Quota", "Provider", "Storage", "InvalidCallback"]),
  message: Schema.String
}) {}
export const failed = (kind: SubscriptionFailed["kind"], message: string) => new SubscriptionFailed({ kind, message })
export const Credential = Schema.Struct({
  clientId: bounded,
  subject: bounded,
  accessToken: Schema.RedactedFromValue(bounded),
  refreshToken: Schema.RedactedFromValue(bounded),
  expiresAt: Schema.Number,
  verified: Schema.Boolean
})
export type Credential = typeof Credential.Type
export const PersistentState = Schema.Struct({
  pendingClientId: Schema.optional(bounded),
  hostId: Schema.String.check(Schema.isPattern(/^urn:uuid:[0-9a-f-]{36}$/u)),
  registration: Schema.optional(Schema.Struct({ clientId: bounded, subject: bounded })),
  credential: Schema.optional(Credential)
})
export type PersistentState = typeof PersistentState.Type
export const TokenResponse = Schema.Struct({
  access_token: Schema.RedactedFromValue(bounded),
  refresh_token: Schema.optional(Schema.RedactedFromValue(bounded)),
  id_token: Schema.optional(Schema.RedactedFromValue(bounded)),
  expires_in: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(maximumTokenLifetimeSeconds)),
  scope: Schema.optional(Schema.String)
})
export type TokenResponse = typeof TokenResponse.Type
// SIWC exposes a subscription catalog, not the ordinary API-key {data:[{id}]} catalog.
export const ModelCatalog = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      slug: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximumModelNameLength)),
      visibility: Schema.String,
      supported_in_api: Schema.Boolean
    })
  ).check(Schema.isMaxLength(maximumModels))
})
export const issuer = "https://auth.openai.com"
export const resource = "https://api.openai.com/v1"
export const sharingScope = "chatgpt.tokens.use.direct"
export const timeoutMillis = 15000
export const maximumBodyBytes = 1048576

export const DisconnectOutcome = Schema.Struct({
  revocation: Schema.Literals(["Confirmed", "Unconfirmed", "NotNeeded"])
})
export type DisconnectOutcome = typeof DisconnectOutcome.Type

export const DisconnectMode = Schema.Literals(["RetainRegistration", "ChangeAccount"])
export type DisconnectMode = typeof DisconnectMode.Type
