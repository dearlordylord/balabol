import type { AnswerEvent } from "../answer-generation/index.ts"
import type { DeliveryPayload, Receipt, PriorSnapshot } from "../memory/index.ts"
import type {
  DeliverySettlement,
  DeliveryTicket,
  ResponseInvalidation,
  ResponseTarget,
  ReplyDeliveryUpdate
} from "./delivery.ts"
import type { Reply, StorageUnavailable, ReplyBusy, ReplyNotFound, InvalidInput } from "./contracts.ts"
import type { ReplyFailure, OwnedResponseWork } from "./response-state.ts"

export type ResponseError = StorageUnavailable | ReplyBusy | ReplyNotFound | InvalidInput
export type ResponseResult =
  | { readonly kind: "Done" }
  | { readonly kind: "Reply"; readonly reply: Reply | null }
  | { readonly kind: "Observer"; readonly token: string }
  | { readonly kind: "Registered"; readonly registrationId: string; readonly snapshot: ReplyDeliveryUpdate }
export type ResponseEvent =
  | {
      readonly kind: "PendingChecked"
      readonly requestId: string
      readonly payload: DeliveryPayload | undefined
      readonly result?: "Reply" | "Done"
      readonly input: Receipt | undefined
    }
  | {
      readonly kind: "Start"
      readonly requestId: string
      readonly input: Receipt
      readonly responseId: string
      readonly issuedRevision: bigint
      readonly granted: boolean
      readonly superseded: boolean
    }
  | {
      readonly kind: "Admit"
      readonly joinRevision?: bigint
      readonly requestId: string
      readonly reason: ResponseInvalidation["reason"]
    }
  | {
      readonly kind: "Interrupt"
      readonly joinRevision?: bigint
      readonly requestId: string
      readonly target: ResponseTarget
      readonly reason: ResponseInvalidation["reason"]
    }
  | { readonly kind: "IntentAdvanced"; readonly revision: bigint }
  | { readonly kind: "Observe"; readonly requestId: string; readonly inputDeliveryId: string; readonly token: string }
  | { readonly kind: "Release"; readonly requestId: string; readonly inputDeliveryId: string; readonly token: string }
  | { readonly kind: "Cancel"; readonly requestId: string; readonly inputDeliveryId: string }
  | { readonly kind: "AttachmentExpired"; readonly attempt: bigint; readonly operation: bigint }
  | {
      readonly kind: "DeadlineExpired"
      readonly attempt: bigint
      readonly operation: bigint
      readonly ticket: DeliveryTicket
    }
  | {
      readonly kind: "Register"
      readonly requestId: string
      readonly registrationId: string
      readonly completionMillis: number
    }
  | { readonly kind: "Detach"; readonly requestId: string; readonly registrationId: string }
  | { readonly kind: "Settle"; readonly requestId: string; readonly settlement: DeliverySettlement }
  | {
      readonly kind: "DeliveryPrepared"
      readonly attempt: bigint
      readonly operation: bigint
      readonly registrationId: string
      readonly deliveryId: string
      readonly now: number
    }
  | {
      readonly kind: "ContextReady"
      readonly attempt: bigint
      readonly operation: bigint
      readonly snapshot: PriorSnapshot
    }
  | {
      readonly kind: "ProviderEvent"
      readonly attempt: bigint
      readonly operation: bigint
      readonly event: AnswerEvent
    }
  | { readonly kind: "ProviderEnded"; readonly attempt: bigint; readonly operation: bigint }
  | { readonly kind: "WorkFailed"; readonly attempt: bigint; readonly operation: bigint; readonly error: ReplyFailure }
  | { readonly kind: "WorkFinished"; readonly attempt: bigint; readonly operation: bigint }
  | {
      readonly kind: "TerminalStored"
      readonly attempt: bigint
      readonly operation: bigint
      readonly invocation: bigint
      readonly payload: DeliveryPayload
      readonly receipt: Receipt
    }
  | {
      readonly kind: "TerminalFailed"
      readonly attempt: bigint
      readonly operation: bigint
      readonly invocation: bigint
      readonly error: StorageUnavailable
    }
  | {
      readonly kind: "Retry"
      readonly requestId: string
      readonly inputDeliveryId: string
      readonly responseId: string
    }
  | {
      readonly kind: "RetryChecked"
      readonly pending: DeliveryPayload | undefined
      readonly requestId: string
      readonly operation: bigint
      readonly input: Receipt | undefined
      readonly receipt: Receipt | undefined
    }
  | { readonly kind: "RetryRecovered"; readonly requestId: string; readonly operation: bigint; readonly input: Receipt }
  | { readonly kind: "RequestFailed"; readonly requestId: string; readonly error: ResponseError }

export type ResponseCommand =
  | { readonly kind: "ReadPending"; readonly requestId: string }
  | { readonly kind: "Resolve"; readonly requestId: string; readonly result: ResponseResult }
  | { readonly kind: "Reject"; readonly requestId: string; readonly error: ResponseError }
  | {
      readonly kind: "PrepareDelivery"
      readonly attempt: bigint
      readonly operation: bigint
      readonly registrationId: string
    }
  | { readonly kind: "PrepareContext"; readonly attempt: bigint; readonly operation: bigint; readonly input: Receipt }
  | {
      readonly kind: "Generate"
      readonly attempt: bigint
      readonly operation: bigint
      readonly input: Receipt
      readonly responseId: string
      readonly responseLanguage: string
      readonly prior: string
    }
  | { readonly kind: "CancelWork"; readonly work: OwnedResponseWork }
  | {
      readonly kind: "PersistTerminal"
      readonly attempt: bigint
      readonly operation: bigint
      readonly invocation: bigint
      readonly payload: DeliveryPayload
    }
  | {
      readonly kind: "ScheduleAttachment"
      readonly attempt: bigint
      readonly operation: bigint
      readonly millis: number
    }
  | {
      readonly kind: "ScheduleDeadline"
      readonly attempt: bigint
      readonly operation: bigint
      readonly ticket: DeliveryTicket
    }
  | { readonly kind: "OpenTicket"; readonly ticket: DeliveryTicket }
  | { readonly kind: "CloseTicket"; readonly ticket: DeliveryTicket }
  | { readonly kind: "PublishDelivery"; readonly update: ReplyDeliveryUpdate }
  | { readonly kind: "CloseSubscription"; readonly registrationId: string }
  | {
      readonly kind: "ReadRetry"
      readonly requestId: string
      readonly operation: bigint
      readonly inputDeliveryId: string
    }
  | { readonly kind: "RecoverMemory"; readonly requestId: string; readonly operation: bigint; readonly input: Receipt }
