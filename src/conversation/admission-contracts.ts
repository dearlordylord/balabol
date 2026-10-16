import type { Effect } from "effect"
import type {
  SendMessage,
  Message,
  InvalidInput,
  DeliveryConflict,
  ReplyBusy,
  StorageUnavailable
} from "./contracts.ts"

/** Host-scoped capability; retired handles never identify a subsequently opened source. */
export type InputSource = bigint
export type InputReservation = { readonly operationId: bigint; readonly deliveryId: string }
export type InputIntent = {
  readonly message: SendMessage
  readonly source?: { readonly capability: InputSource; readonly sequence: number }
}
export type SpeechFence = { readonly capability: InputSource; readonly sequence: number; readonly fenceId: string }
export type FenceAcknowledgement = { readonly revision: bigint }
export type AdmissionFailure = InvalidInput | DeliveryConflict | ReplyBusy | StorageUnavailable
export type AdmissionService = {
  readonly openInputSource: () => Effect.Effect<InputSource, InvalidInput>
  readonly closeInputSource: (source: InputSource) => Effect.Effect<void, InvalidInput>
  readonly registerInput: (intent: InputIntent) => Effect.Effect<InputReservation, AdmissionFailure>
  readonly submitInput: (reservation: InputReservation) => Effect.Effect<Message, AdmissionFailure>
  readonly abandonInput: (reservation: InputReservation) => Effect.Effect<void, AdmissionFailure>
  readonly fenceSpeech: (fence: SpeechFence) => Effect.Effect<FenceAcknowledgement, InvalidInput>
}

// Reuses the prototype Voice handed-input bound; retries and fences do not consume a new reservation.
export const maximumPendingAdmissions = 2
