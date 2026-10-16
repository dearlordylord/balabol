import type { Deferred, Queue } from "effect"
import type { DeliveryEvidence } from "../memory/index.ts"
import type { Message } from "./contracts.ts"
import type { Command, AdmissionEvent } from "./admission-core/generated/core.mjs"
import type { AdmissionFailure } from "./admission-contracts.ts"
import type { ResponseEvent } from "./response-events.ts"
import type { Request } from "./admission-api.ts"

export type Completion =
  | { readonly kind: "Revoked"; readonly operation: bigint }
  | { readonly kind: "RevokeFailed"; readonly operation: bigint; readonly error: AdmissionFailure }
  | { readonly kind: "Classified"; readonly operation: bigint; readonly evidence: DeliveryEvidence | undefined }
  | { readonly kind: "Started"; readonly operation: bigint }
  | { readonly kind: "Core"; readonly operation: bigint; readonly event: AdmissionEvent }
  | { readonly kind: "Accepted"; readonly operation: bigint; readonly receipt: Message; readonly existing: boolean }
  | { readonly kind: "Failed"; readonly operation: bigint; readonly error: AdmissionFailure }
export type Envelope = Request | Completion | { readonly kind: "Response"; readonly event: ResponseEvent }
export type Lease = {
  readonly operation: bigint
  readonly result: Deferred.Deferred<Message, AdmissionFailure>
  readonly commands: Queue.Queue<Command>
}
export type Gate = { readonly operation: bigint; readonly open: boolean }

export type OperationCompletion = Extract<Completion, { kind: "Accepted" | "Failed" | "Core" }>
export const isOperationCompletion = (request: Completion): request is OperationCompletion =>
  request.kind === "Accepted" || request.kind === "Failed" || request.kind === "Core"
