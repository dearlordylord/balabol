import { Schema } from "effect"
import { LanguageTag, LanguageSpans, validLanguageSpans } from "../language/index.ts"
import { sameDeliveryFailure, DeliveryFailure, DeliveryId, MessageText, Position, Receipt } from "../memory/index.ts"
export { StorageUnavailable, WriterUnavailable } from "../memory/index.ts"
export const SendMessage = Schema.Struct({
  deliveryId: DeliveryId,
  text: MessageText,
  languageSpans: Schema.optionalKey(LanguageSpans),
  detectedLanguage: Schema.optionalKey(Schema.NullOr(LanguageTag))
}).check(Schema.makeFilter((value) => validLanguageSpans(value.text, value.languageSpans ?? [])))
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
// Display history walks backwards; synchronization retains the separate forward cursor.
export const OlderPageRequest = Schema.Struct({ before: Schema.optionalKey(Position), limit: PageRequest.fields.limit })
export type OlderPageRequest = typeof OlderPageRequest.Type
export const OlderMessagePage = Schema.Struct({ messages: Schema.Array(Message), nextBefore: Schema.NullOr(Position) })
export type OlderMessagePage = typeof OlderMessagePage.Type
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
  responseLanguage: Schema.optionalKey(LanguageTag),
  generationStarted: Schema.optionalKey(Schema.Boolean),
  generationCompleted: Schema.optionalKey(Schema.Boolean),
  inputDeliveryId: DeliveryId,
  sequence: Position,
  text: Schema.String.check(Schema.isMaxLength(maximumReplyLength)),
  languageSpans: Schema.optionalKey(LanguageSpans)
}
export const ReplyError = DeliveryFailure
const validCompletion = (value: {
  receipt: Message | null
  responseId: string
  inputDeliveryId: string
  text: string
  languageSpans?: typeof LanguageSpans.Type
}) =>
  value.receipt !== null &&
  value.receipt.role === "assistant" &&
  value.receipt.responseId === value.responseId &&
  value.receipt.deliveryId === value.responseId &&
  value.receipt.inputDeliveryId === value.inputDeliveryId &&
  value.receipt.text === value.text &&
  JSON.stringify(value.receipt.languageSpans) === JSON.stringify(value.languageSpans ?? [])
const validFailedReply = (value: {
  receipt: Message | null
  error: typeof ReplyError.Type
  responseId: string
  inputDeliveryId: string
  text: string
  languageSpans?: typeof LanguageSpans.Type
}) => value.receipt === null || (validCompletion(value) && sameDeliveryFailure(value.receipt.failure, value.error))
const validTerminalOutcome = (state: string, receipt: Message | null) =>
  receipt !== null &&
  receipt.failure === undefined &&
  (state === "Interrupted" ? receipt.outcome === "interrupted" : receipt.outcome !== "interrupted")
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
  Schema.Struct({
    ...responseFields,
    state: Schema.Literal("Failed"),
    error: ReplyError,
    receipt: Schema.NullOr(Message)
  })
]).check(
  Schema.makeFilter((value) => validLanguageSpans(value.text, value.languageSpans ?? [])),
  Schema.makeFilter((value) => {
    if (value.responseId === value.inputDeliveryId) return false
    if (value.generationCompleted === true && value.generationStarted !== true) return false
    if (value.state === "Waiting") return value.text.length === 0
    if (["Streaming", "Delivering"].includes(value.state)) return value.text.length > 0
    if (value.state === "Failed") return validFailedReply(value)
    return validCompletion(value) && validTerminalOutcome(value.state, value.receipt)
  })
)
export type Reply = typeof Reply.Type

export class ReplyBusy extends Schema.TaggedError<ReplyBusy>()("ReplyBusy", { message: Schema.String }) {}

export class ReplyNotFound extends Schema.TaggedError<ReplyNotFound>()("ReplyNotFound", { message: Schema.String }) {}

export const CurrentTurn = Schema.NullOr(Schema.Struct({ input: Message, reply: Reply }))
export type CurrentTurn = typeof CurrentTurn.Type
