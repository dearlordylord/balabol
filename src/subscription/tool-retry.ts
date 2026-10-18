import { Effect, Schedule, Stream } from "effect"
import { inferenceFailed, type InferenceFailed } from "./inference-model.ts"
import type { ToolInferenceEvent, ToolRetryObserver } from "./tool-model.ts"

const maximumAttempts = 3
const totalDeadlineMillis = 60000
/** Retry one immutable model request only before any output escapes; never rerun the agent or its tools. */
export const retryToolInference = (
  makeAttempt: () => Stream.Stream<ToolInferenceEvent, InferenceFailed>,
  onRetry: ToolRetryObserver = () => Effect.void
): Stream.Stream<ToolInferenceEvent, InferenceFailed> =>
  Stream.unwrap(
    Effect.sync(() => {
      let released = false
      const policy = Schedule.exponential("1 second", maximumAttempts).pipe(
        Schedule.setInputType<InferenceFailed>(),
        Schedule.while(({ attempt, input }) =>
          Effect.succeed(attempt < maximumAttempts && !released && retryable(input))
        ),
        Schedule.tap(({ attempt }) => onRetry({ attempt: attempt + 1, maximumAttempts }))
      )
      return Stream.unwrap(Effect.sync(makeAttempt)).pipe(
        Stream.tap(() =>
          Effect.sync(() => {
            released = true
          })
        ),
        Stream.retry(policy),
        Stream.interruptWhen(
          Effect.sleep(totalDeadlineMillis).pipe(Effect.andThen(Effect.fail(inferenceFailed("Deadline"))))
        )
      )
    })
  )

const retryable = (error: InferenceFailed) =>
  error.reason === "Transport" ||
  error.reason === "Deadline" ||
  error.reason === "Unavailable" ||
  (error.reason === "Failed" && error.diagnostic?.reason === "Failed" && error.diagnostic.status === undefined)
