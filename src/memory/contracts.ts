import { Schema } from "effect"

export const DeliveryId = Schema.String.check(Schema.isUUID())
export const Position = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const maximumTextLength = 100_000
export const MessageText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximumTextLength))
export const DeliveryPayload = Schema.Struct({ deliveryId: DeliveryId, text: MessageText })
export type DeliveryPayload = typeof DeliveryPayload.Type
export const Receipt = Schema.Struct({
  deliveryId: DeliveryId,
  recordId: Position,
  position: Position,
  text: MessageText
})
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
