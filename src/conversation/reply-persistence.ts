import { auditIdentity, withAuditSpan } from "../operation-audit/index.ts"
import { Effect } from "effect"
import { samePayload, type DeliveryPayload, type Memory } from "../memory/index.ts"

/** A storage error may follow the durable commit; accept only its matching receipt. */
export const appendReply = (memory: Memory["Service"], payload: DeliveryPayload) => {
  const attributes = {
    input: payload.inputDeliveryId === undefined ? undefined : auditIdentity(payload.inputDeliveryId)
  }
  return memory.append(payload).pipe(
    withAuditSpan("conversation.append", payload.deliveryId, attributes),
    Effect.catch((error) =>
      memory.find(payload.deliveryId).pipe(
        Effect.flatMap((found) =>
          found?.state === "Accepted" && samePayload(found.receipt, payload)
            ? Effect.succeed(found.receipt)
            : Effect.fail(error)
        ),
        withAuditSpan("conversation.verify", payload.deliveryId, attributes)
      )
    )
  )
}
