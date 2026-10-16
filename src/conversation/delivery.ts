import { randomUUID } from "node:crypto"
import { Clock, Effect, Schema } from "effect"
import { DeliveryId } from "../memory/index.ts"
import { InvalidInput, ReplyBusy } from "./contracts.ts"
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
  error: Schema.optionalKey(Schema.Struct({ code: Schema.String, message: Schema.String }))
})
export type DeliverySettlement = typeof DeliverySettlement.Type
export const ResponseInvalidation = Schema.Struct({
  ...ResponseTarget.fields,
  reason: Schema.Literals(["Interrupted", "Failed", "Deadline", "Detached"])
})
export type ResponseInvalidation = typeof ResponseInvalidation.Type
export interface ReplyDeliveryRegistration {
  completionMillis: number
  started: (ticket: DeliveryTicket) => void
  invalidated: (target: ResponseInvalidation) => void
}
export class ReplyDelivery {
  #registration: (ReplyDeliveryRegistration & { registrationId: string }) | undefined
  #ticket: DeliveryTicket | undefined
  register(input: ReplyDeliveryRegistration) {
    return Schema.decodeUnknownEffect(Timing)(input.completionMillis).pipe(
      Effect.mapError(() => new InvalidInput({ message: "Invalid delivery deadline" })),
      Effect.flatMap(() =>
        Effect.suspend(() => {
          if (this.#registration !== undefined)
            return Effect.fail(new ReplyBusy({ message: "Reply delivery is already registered" }))
          const registrationId = randomUUID()
          this.#registration = { ...input, registrationId }
          return Effect.succeed({ registrationId })
        })
      )
    )
  }
  begin(target: ResponseTarget, authorized: () => boolean = () => true) {
    return Effect.gen({ self: this }, function* () {
      const registration = this.#registration
      if (registration === undefined) return undefined
      const now = yield* Clock.currentTimeMillis
      if (!authorized()) return undefined
      const ticket = {
        ...target,
        registrationId: registration.registrationId,
        deliveryId: randomUUID(),
        deadlineAt: now + registration.completionMillis
      }
      this.#ticket = ticket
      registration.started(ticket)
      return ticket
    })
  }
  snapshot(registrationId: string) {
    return this.#registration?.registrationId === registrationId ? (this.#ticket ?? null) : null
  }
  matches(target: ResponseTarget) {
    return this.#ticket?.responseId === target.responseId && this.#ticket.inputDeliveryId === target.inputDeliveryId
  }
  accepts(ticket: DeliveryTicket) {
    return (
      this.#ticket?.deliveryId === ticket.deliveryId &&
      this.#ticket.registrationId === ticket.registrationId &&
      this.matches(ticket)
    )
  }
  invalidate(target: ResponseTarget, reason: ResponseInvalidation["reason"] = "Interrupted") {
    if (!this.matches(target)) return
    this.#ticket = undefined
    this.#registration?.invalidated({ ...target, reason })
  }
  complete(target: ResponseTarget) {
    if (this.matches(target)) this.#ticket = undefined
  }
  detach(registrationId: string) {
    if (this.#registration?.registrationId === registrationId) {
      this.#registration = undefined
      this.#ticket = undefined
    }
  }
}
