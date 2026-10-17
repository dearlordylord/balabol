import { Clock, Effect } from "effect"
import type { Fiber, Scope } from "effect"
import type { SessionCommand, SessionEvent } from "./session-events.ts"

type Command = Extract<SessionCommand, { kind: "ScheduleExpiry" | "CancelExpiry" }>
type Due = Extract<SessionEvent, { kind: "ExpiryDue" }>
/** The owner chooses deadlines and identities. This shell only owns scoped,
 * cooperative sleeps; a queued late wake remains an ordinary correlated fact. */
export const makeSessionExpiryExecutor = (scope: Scope.Scope, notify: (event: Due) => void) => {
  const timers = new Map<number, { fiber?: Fiber.Fiber<void> }>()
  return (command: Command): Effect.Effect<void> => {
    if (command.kind === "CancelExpiry")
      return Effect.sync(() => timers.get(command.operation)?.fiber?.interruptUnsafe())
    return Effect.gen(function* () {
      const entry: { fiber?: Fiber.Fiber<void> } = {}
      timers.set(command.operation, entry)
      entry.fiber = yield* Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        yield* Effect.sleep(Math.max(0, command.deadlineAt - now))
        notify({
          kind: "ExpiryDue",
          operation: command.operation,
          deadlineAt: command.deadlineAt,
          now: yield* Clock.currentTimeMillis
        })
      }).pipe(
        Effect.interruptible,
        Effect.ensuring(
          Effect.sync(() => {
            timers.delete(command.operation)
          })
        ),
        Effect.forkIn(scope, { startImmediately: true, uninterruptible: true })
      )
    }).pipe(Effect.uninterruptible)
  }
}
