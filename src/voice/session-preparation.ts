import { Clock, Effect } from "effect"
import { failed } from "./contracts.ts"
import { sessionJoinMillis } from "./session-state.ts"
const expired = () => Effect.fail(failed("StartExpired", "The original voice session has ended"))
/** Preparation has no joined peer yet. Interpret the same absolute join deadline
 * used by the Session state; cancellation finalizers settle before failure. */
export const withinSessionPreparationDeadline = <A, E, R>(startedAt: number, work: Effect.Effect<A, E, R>) =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) => {
      const remaining = startedAt + sessionJoinMillis - now
      return remaining <= 0 ? expired() : work.pipe(Effect.timeoutOrElse({ duration: remaining, orElse: expired }))
    })
  )
