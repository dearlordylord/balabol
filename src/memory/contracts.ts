import { Schema } from "effect"

export const DeliveryId = Schema.String.check(Schema.isUUID())
export const Position = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const maximumTextLength = 100_000
export const MessageText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximumTextLength))
export const validMessageIdentity = (value: {
  deliveryId: string
  role?: "user" | "assistant"
  inputDeliveryId?: string | null
  responseId?: string | null
}) => {
  if (value.role !== "assistant") return value.inputDeliveryId == null && value.responseId == null
  return (
    typeof value.inputDeliveryId === "string" &&
    value.responseId === value.deliveryId &&
    value.inputDeliveryId !== value.deliveryId
  )
}
export const DeliveryPayload = Schema.Struct({
  deliveryId: DeliveryId,
  text: MessageText,
  role: Schema.optionalKey(Schema.Literals(["user", "assistant"])),
  inputDeliveryId: Schema.optionalKey(DeliveryId),
  responseId: Schema.optionalKey(DeliveryId)
}).check(Schema.makeFilter(validMessageIdentity))
export type DeliveryPayload = typeof DeliveryPayload.Type
export const Receipt = Schema.Struct({
  deliveryId: DeliveryId,
  recordId: Position,
  position: Position,
  text: MessageText,
  role: Schema.optionalKey(Schema.Literals(["user", "assistant"])),
  inputDeliveryId: Schema.optionalKey(DeliveryId),
  responseId: Schema.optionalKey(DeliveryId)
}).check(Schema.makeFilter(validMessageIdentity))
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
