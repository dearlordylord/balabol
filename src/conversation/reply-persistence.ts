import { Effect } from "effect"
import { samePayload, type DeliveryPayload, type Memory } from "../memory/index.ts"

/** A storage error may follow the durable commit; accept only its matching receipt. */
export const appendReply = (memory: Memory["Service"], payload: DeliveryPayload) =>
  memory
    .append(payload)
    .pipe(
      Effect.catch((error) =>
        memory
          .find(payload.deliveryId)
          .pipe(
            Effect.flatMap((found) =>
              found?.state === "Accepted" && samePayload(found.receipt, payload)
                ? Effect.succeed(found.receipt)
                : Effect.fail(error)
            )
          )
      )
    )
