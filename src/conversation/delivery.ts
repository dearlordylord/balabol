import { Effect, Schema, type Stream } from "effect"
import { DeliveryFailure, DeliveryId } from "../memory/index.ts"
import { InvalidInput } from "./contracts.ts"
const maximumDeadlineMillis = 300000
const Timing = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(maximumDeadlineMillis))
export const ResponseTarget = Schema.Struct({ responseId: DeliveryId, inputDeliveryId: DeliveryId })
export type ResponseTarget = typeof ResponseTarget.Type
export const DeliveryTicket = Schema.Struct({
  ...ResponseTarget.fields,
  registrationId: DeliveryId,
  deliveryId: DeliveryId,
  deadlineAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
})
export type DeliveryTicket = typeof DeliveryTicket.Type
export const DeliverySettlement = Schema.Struct({
  ...DeliveryTicket.fields,
  outcome: Schema.Literals(["Completed", "Failed"]),
  error: Schema.optionalKey(DeliveryFailure)
})
export type DeliverySettlement = typeof DeliverySettlement.Type
export const ResponseInvalidation = Schema.Struct({
  ...ResponseTarget.fields,
  reason: Schema.Literals(["Interrupted", "Failed", "Deadline", "Detached"])
})
export type ResponseInvalidation = typeof ResponseInvalidation.Type
export interface ReplyDeliveryRegistration {
  readonly completionMillis: number
}
export const ReplyDeliveryUpdate = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("Idle"), registrationId: DeliveryId, sequence: Schema.Int }),
  Schema.Struct({
    kind: Schema.Literal("Started"),
    registrationId: DeliveryId,
    sequence: Schema.Int,
    ticket: DeliveryTicket
  }),
  Schema.Struct({
    kind: Schema.Literal("Invalidated"),
    registrationId: DeliveryId,
    sequence: Schema.Int,
    ticket: DeliveryTicket,
    reason: ResponseInvalidation.fields.reason,
    failure: Schema.optionalKey(DeliveryFailure)
  }),
  Schema.Struct({
    kind: Schema.Literal("Delivered"),
    registrationId: DeliveryId,
    sequence: Schema.Int,
    ticket: DeliveryTicket
  })
])
export type ReplyDeliveryUpdate = typeof ReplyDeliveryUpdate.Type
export interface ReplyDeliveryAuthorization {
  readonly isAuthorized: () => boolean
  readonly signal: AbortSignal
}
export interface ReplyDeliverySubscription {
  readonly registrationId: string
  readonly snapshot: ReplyDeliveryUpdate
  readonly updates: Stream.Stream<ReplyDeliveryUpdate>
}
export const parseDeliveryTiming = (value: number) =>
  Schema.decodeUnknownEffect(Timing)(value).pipe(
    Effect.mapError(() => new InvalidInput({ message: "Invalid delivery deadline" }))
  )
