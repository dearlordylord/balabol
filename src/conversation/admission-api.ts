import { Deferred, Effect, Schema } from "effect"
import { DeliveryId } from "../memory/index.ts"
import { SendMessage, InvalidInput, type Message } from "./contracts.ts"
import type {
  AdmissionService,
  AdmissionFailure,
  InputIntent,
  InputReservation,
  InputSource,
  SpeechFence,
  FenceAcknowledgement
} from "./admission-contracts.ts"

export const maximumToken = 281474976710655n
const Token = Schema.BigInt.check(Schema.makeFilter((value) => value > 0n && value <= maximumToken))
const Sequence = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number(maximumToken) }))
const Source = Schema.Struct({ capability: Token, sequence: Sequence })
const Intent = Schema.Struct({ message: SendMessage, source: Schema.optionalKey(Source) })
const Reservation = Schema.Struct({ operationId: Token, deliveryId: DeliveryId })
const Fence = Schema.Struct({ capability: Token, sequence: Sequence, fenceId: DeliveryId })

export const invalid = () => new InvalidInput({ message: "Invalid or retired conversation input operation" })
export type Outcome =
  | { readonly kind: "Source"; readonly capability: InputSource }
  | { readonly kind: "Reservation"; readonly reservation: InputReservation }
  | { readonly kind: "Fence"; readonly acknowledgement: FenceAcknowledgement }
  | { readonly kind: "Done" }
  | { readonly kind: "Waiting"; readonly result: Deferred.Deferred<Message, AdmissionFailure> }
export type RequestResult = Deferred.Deferred<Outcome, AdmissionFailure>
export type Request =
  | { readonly kind: "Open"; readonly result: RequestResult }
  | { readonly kind: "Close"; readonly capability: InputSource; readonly result: RequestResult }
  | { readonly kind: "Register"; readonly intent: InputIntent; readonly result: RequestResult }
  | { readonly kind: "Fence"; readonly fence: SpeechFence; readonly result: RequestResult }
  | { readonly kind: "Submit" | "Abandon"; readonly reservation: InputReservation; readonly result: RequestResult }

export const admissionClient = (post: (request: Request) => Effect.Effect<void>): AdmissionService => {
  const ask = Effect.fn("Conversation.admissionRequest")(function* (make: (result: RequestResult) => Request) {
    const result = yield* Deferred.make<Outcome, AdmissionFailure>()
    yield* post(make(result))
    return yield* Deferred.await(result)
  }, Effect.uninterruptible)
  const parseIntent = (intent: InputIntent) =>
    Schema.decodeUnknownEffect(Intent)(intent).pipe(
      Effect.mapError(invalid),
      Effect.map((parsed) => ({
        ...parsed,
        message: { ...parsed.message, languageSpans: parsed.message.languageSpans ?? [] }
      }))
    )
  const service: AdmissionService = {
    openInputSource: () =>
      ask((result) => ({ kind: "Open", result })).pipe(
        Effect.map((outcome) => {
          if (outcome.kind !== "Source") throw new Error("Invalid source acknowledgement")
          return outcome.capability
        }),
        Effect.mapError(() => invalid())
      ),
    closeInputSource: (capability) =>
      Schema.decodeUnknownEffect(Token)(capability).pipe(
        Effect.mapError(invalid),
        Effect.flatMap((parsed) => ask((result) => ({ kind: "Close", capability: parsed, result }))),
        Effect.asVoid,
        Effect.mapError(() => invalid())
      ),
    registerInput: (intent) =>
      parseIntent(intent).pipe(
        Effect.flatMap((parsed) => ask((result) => ({ kind: "Register", intent: parsed, result }))),
        Effect.map((outcome) => {
          if (outcome.kind !== "Reservation") throw new Error("Invalid reservation acknowledgement")
          return outcome.reservation
        })
      ),
    submitInput: (reservation) =>
      Schema.decodeUnknownEffect(Reservation)(reservation).pipe(
        Effect.mapError(invalid),
        Effect.flatMap((parsed) => ask((result) => ({ kind: "Submit", reservation: parsed, result }))),
        Effect.flatMap((outcome) =>
          outcome.kind === "Waiting"
            ? Deferred.await(outcome.result).pipe(Effect.map((receipt) => structuredClone(receipt)))
            : Effect.fail(invalid())
        ),
        Effect.uninterruptible
      ),
    abandonInput: (reservation) =>
      Schema.decodeUnknownEffect(Reservation)(reservation).pipe(
        Effect.mapError(invalid),
        Effect.flatMap((parsed) => ask((result) => ({ kind: "Abandon", reservation: parsed, result }))),
        Effect.asVoid
      ),
    fenceSpeech: (input) =>
      Schema.decodeUnknownEffect(Fence)(input).pipe(
        Effect.mapError(invalid),
        Effect.flatMap((fence) =>
          fence.sequence > 0 ? ask((result) => ({ kind: "Fence", fence, result })) : Effect.fail(invalid())
        ),
        Effect.map((outcome) => {
          if (outcome.kind !== "Fence") throw new Error("Invalid fence acknowledgement")
          return outcome.acknowledgement
        }),
        Effect.mapError(() => invalid())
      )
  }

  return service
}
