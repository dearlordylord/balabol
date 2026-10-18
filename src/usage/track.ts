import { randomUUID } from "node:crypto"
import { Cause, Clock, Effect, Exit, Option, Schema, Stream } from "effect"
import { withAuditSpan } from "../operation-audit/index.ts"
import { TokenUsage, type UsageLedger, type UsageAttempt } from "./contracts.ts"

const Observation = Schema.Struct({ kind: Schema.Literal("Completed"), usage: Schema.optionalKey(TokenUsage) })
/** Explicitly supplied in production; pre-accounting adapter tests may omit the ledger. */
export const trackInferenceUsage = <A, E, R>(
  stream: Stream.Stream<A, E, R>,
  model: UsageAttempt["model"],
  ledger?: UsageLedger["Service"],
  category: UsageAttempt["category"] = "chat",
  observation: () => TokenUsage | undefined = () => undefined
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      if (ledger === undefined) return stream
      let attempt: UsageAttempt = {
        id: randomUUID(),
        category,
        model,
        startedAt: yield* Clock.currentTimeMillis,
        outcome: "running",
        tokens: {}
      }
      const record = () => ledger.record(attempt).pipe(withAuditSpan("usage.record"), Effect.ignore)
      yield* record()
      return stream.pipe(
        Stream.tap((event) =>
          Effect.sync(() => {
            const value = Schema.decodeUnknownOption(Observation)(event)
            if (Option.isSome(value) && value.value.usage !== undefined)
              attempt = { ...attempt, tokens: value.value.usage }
          })
        ),
        Stream.onExit((exit) =>
          Effect.suspend(() => {
            attempt = {
              ...attempt,
              tokens: observation() ?? attempt.tokens,
              outcome: Exit.isSuccess(exit)
                ? "completed"
                : Cause.hasInterruptsOnly(exit.cause)
                  ? "interrupted"
                  : "failed"
            }
            return record()
          })
        )
      )
    })
  )
