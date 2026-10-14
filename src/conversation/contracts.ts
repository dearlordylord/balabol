import { Schema } from "effect"
import { DeliveryId, MessageText, Position, Receipt } from "../memory/index.ts"
export { StorageUnavailable, WriterUnavailable } from "../memory/index.ts"
export const SendMessage = Schema.Struct({ deliveryId: DeliveryId, text: MessageText })
export type SendMessage = typeof SendMessage.Type
export const Message = Receipt
export type Message = typeof Message.Type
export const maximumPageSize = 100
export const PageRequest = Schema.Struct({
  after: Schema.optionalKey(Position),
  limit: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(maximumPageSize))
})
export type PageRequest = typeof PageRequest.Type
export const MessagePage = Schema.Struct({ messages: Schema.Array(Message), nextAfter: Schema.NullOr(Position) })
export type MessagePage = typeof MessagePage.Type
export class DeliveryConflict extends Schema.TaggedError<DeliveryConflict>()("DeliveryConflict", {
  message: Schema.String
}) {}
export class InvalidInput extends Schema.TaggedError<InvalidInput>()("InvalidInput", { message: Schema.String }) {}
export const ErrorResponse = Schema.Struct({
  error: Schema.Struct({
    code: Schema.Literals([
      "DeliveryConflict",
      "StorageUnavailable",
      "WriterUnavailable",
      "InvalidInput",
      "ReplyBusy",
      "ReplyNotFound"
    ]),
    message: Schema.String
  })
})

const maximumReplyLength = 100_000
const responseFields = {
  responseId: DeliveryId,
  inputDeliveryId: DeliveryId,
  sequence: Position,
  text: Schema.String.check(Schema.isMaxLength(maximumReplyLength))
}
export const ReplyError = Schema.Struct({
  code: Schema.Literals([
    "MemoryPending",
    "MemoryFailed",
    "ProviderFailed",
    "InvalidProviderStream",
    "StorageUnavailable",
    "Restarted",
    "Cancelled"
  ]),
  message: Schema.String
})
const validCompletion = (value: {
  receipt: Message | null
  responseId: string
  inputDeliveryId: string
  text: string
}) =>
  value.receipt !== null &&
  value.receipt.role === "assistant" &&
  value.receipt.responseId === value.responseId &&
  value.receipt.deliveryId === value.responseId &&
  value.receipt.inputDeliveryId === value.inputDeliveryId &&
  value.receipt.text === value.text
export const Reply = Schema.Union([
  Schema.Struct({
    ...responseFields,
    state: Schema.Literals(["Waiting", "Streaming", "Delivering"]),
    error: Schema.Null,
    receipt: Schema.Null
  }),
  Schema.Struct({
    ...responseFields,
    state: Schema.Literals(["Completed", "Interrupted"]),
    error: Schema.Null,
    receipt: Message
  }),
  Schema.Struct({ ...responseFields, state: Schema.Literal("Failed"), error: ReplyError, receipt: Schema.Null })
]).check(
  Schema.makeFilter((value) => {
    if (value.responseId === value.inputDeliveryId) return false
    if (value.state === "Waiting") return value.text.length === 0
    if (["Streaming", "Delivering"].includes(value.state)) return value.text.length > 0
    if (value.state === "Failed") return true
    return (
      value.receipt !== null &&
      validCompletion(value) &&
      (value.state === "Interrupted"
        ? value.receipt.outcome === "interrupted"
        : value.receipt.outcome !== "interrupted")
    )
  })
)
export type Reply = typeof Reply.Type

export class ReplyBusy extends Schema.TaggedError<ReplyBusy>()("ReplyBusy", { message: Schema.String }) {}

export class ReplyNotFound extends Schema.TaggedError<ReplyNotFound>()("ReplyNotFound", { message: Schema.String }) {}

export const CurrentTurn = Schema.NullOr(Schema.Struct({ input: Message, reply: Reply }))
export type CurrentTurn = typeof CurrentTurn.Type
