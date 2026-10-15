import { Effect, Schema, SchemaGetter } from "effect"

import { LanguageTag, LanguageSpans, validLanguageSpans } from "../language/index.ts"

export const StoredLanguageSpans = LanguageSpans.pipe(Schema.withDecodingDefaultKey(Effect.succeed([])))

// UUID letter case is spelling, never a separate delivery or response identity.
export const DeliveryId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.decodeTo(Schema.String.check(Schema.isUUID(), Schema.isLowercased()), {
    decode: SchemaGetter.transform((id) => id.toLowerCase()),
    encode: SchemaGetter.passthrough()
  })
)
export const Position = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const maximumTextLength = 100_000
export const MessageText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximumTextLength))
export const validMessageIdentity = (value: {
  deliveryId: string
  role?: "user" | "assistant"
  inputDeliveryId?: string | null
  responseId?: string | null
  outcome?: "completed" | "interrupted" | null
  text?: string
}) => {
  if (value.text === "" && value.outcome !== "interrupted") return false
  if (value.role !== "assistant") return userIdentity(value)
  return (
    typeof value.inputDeliveryId === "string" &&
    value.responseId === value.deliveryId &&
    value.inputDeliveryId !== value.deliveryId
  )
}
const userIdentity = (value: {
  inputDeliveryId?: string | null
  responseId?: string | null
  outcome?: "completed" | "interrupted" | null
}) => value.inputDeliveryId == null && value.responseId == null && value.outcome == null
export const DeliveryPayload = Schema.Struct({
  deliveryId: DeliveryId,
  text: Schema.String.check(Schema.isMaxLength(maximumTextLength)),
  languageSpans: StoredLanguageSpans,
  detectedLanguage: Schema.optionalKey(Schema.NullOr(LanguageTag)),
  responseLanguage: Schema.optionalKey(Schema.NullOr(LanguageTag)),
  role: Schema.optionalKey(Schema.Literals(["user", "assistant"])),
  inputDeliveryId: Schema.optionalKey(DeliveryId),
  responseId: Schema.optionalKey(DeliveryId),
  outcome: Schema.optionalKey(Schema.Literals(["completed", "interrupted"]))
}).check(
  Schema.makeFilter(validMessageIdentity),
  Schema.makeFilter((value) => validLanguageSpans(value.text, value.languageSpans))
)
export type DeliveryPayload = typeof DeliveryPayload.Encoded
export const Receipt = Schema.Struct({
  deliveryId: DeliveryId,
  recordId: Position,
  position: Position,
  text: Schema.String.check(Schema.isMaxLength(maximumTextLength)),
  languageSpans: StoredLanguageSpans,
  detectedLanguage: Schema.optionalKey(Schema.NullOr(LanguageTag)),
  responseLanguage: Schema.optionalKey(Schema.NullOr(LanguageTag)),
  role: Schema.optionalKey(Schema.Literals(["user", "assistant"])),
  inputDeliveryId: Schema.optionalKey(DeliveryId),
  responseId: Schema.optionalKey(DeliveryId),
  outcome: Schema.optionalKey(Schema.Literals(["completed", "interrupted"]))
}).check(
  Schema.makeFilter(validMessageIdentity),
  Schema.makeFilter((value) => validLanguageSpans(value.text, value.languageSpans))
)
export type Receipt = typeof Receipt.Type
export class StorageUnavailable extends Schema.TaggedError<StorageUnavailable>()("StorageUnavailable", {
  message: Schema.String
}) {}
export class WriterUnavailable extends Schema.TaggedError<WriterUnavailable>()("WriterUnavailable", {
  message: Schema.String
}) {}

export const DeliveryEvidence = Schema.Union([
  Schema.Struct({ state: Schema.Literal("Intent"), payload: DeliveryPayload }),
  Schema.Struct({ state: Schema.Literal("Accepted"), receipt: Receipt })
])
export type DeliveryEvidence = typeof DeliveryEvidence.Type

export const PriorSnapshot = Schema.Union([
  Schema.Struct({ state: Schema.Literal("ready"), text: Schema.String }),
  Schema.Struct({ state: Schema.Literals(["pending", "failed"]), text: Schema.Null })
])
export type PriorSnapshot = typeof PriorSnapshot.Type

const maximumSummaryConcurrency = 8
const maximumModelNameLength = 200
export const MemorySettings = Schema.Struct({
  summaryProvider: Schema.Literal("fake"),
  summaryModel: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximumModelNameLength)),
  summaryConcurrency: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maximumSummaryConcurrency }))
})
export type MemorySettings = typeof MemorySettings.Type
export const defaultMemorySettings: MemorySettings = {
  summaryProvider: "fake",
  summaryModel: "luna",
  summaryConcurrency: 1
}

const payloadDefaults = (value: DeliveryPayload) => ({
  ...value,
  role: value.role ?? "user",
  detectedLanguage: value.detectedLanguage ?? null,
  outcome: value.role === "assistant" ? (value.outcome ?? "completed") : undefined
})
export const samePayload = (left: DeliveryPayload, right: DeliveryPayload): boolean => {
  const first = payloadDefaults(left)
  const second = payloadDefaults(right)
  if (JSON.stringify(first.languageSpans ?? []) !== JSON.stringify(second.languageSpans ?? [])) return false
  return (
    ["deliveryId", "text", "detectedLanguage", "role", "inputDeliveryId", "responseId", "outcome"] as const
  ).every((key) => first[key] === second[key])
}
