import { Schema } from "effect"
import { DeliveryPayload, Position, Receipt } from "../memory/index.ts"
export { StorageUnavailable, WriterUnavailable } from "../memory/index.ts"
export const SendMessage = DeliveryPayload
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
    code: Schema.Literals(["DeliveryConflict", "StorageUnavailable", "WriterUnavailable", "InvalidInput"]),
    message: Schema.String
  })
})
