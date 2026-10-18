import { FailureDiagnostic } from "../failure-diagnostic/index.ts"
import { Context, Schema } from "effect"
import type { Effect } from "effect"

const counter = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
export const TokenUsage = Schema.Struct({
  input: Schema.optionalKey(counter),
  cachedInput: Schema.optionalKey(counter),
  output: Schema.optionalKey(counter),
  reasoningOutput: Schema.optionalKey(counter)
}).check(
  Schema.makeFilter(
    (value) =>
      (value.cachedInput === undefined || value.input === undefined || value.cachedInput <= value.input) &&
      (value.reasoningOutput === undefined || value.output === undefined || value.reasoningOutput <= value.output)
  )
)
export type TokenUsage = typeof TokenUsage.Type
export const UsageAttempt = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  category: Schema.Literals(["chat", "memory"]),
  model: Schema.Literals(["gpt-6.1-sol", "gpt-6-luna"]),
  startedAt: counter,
  outcome: Schema.Literals(["running", "completed", "interrupted", "failed"]),
  tokens: TokenUsage
})
export type UsageAttempt = typeof UsageAttempt.Type
export const UsageTotal = Schema.Struct({
  category: UsageAttempt.fields.category,
  model: UsageAttempt.fields.model,
  attempts: counter,
  unreported: counter,
  input: Schema.NullOr(counter),
  cachedInput: Schema.NullOr(counter),
  output: Schema.NullOr(counter),
  reasoningOutput: Schema.NullOr(counter)
})
export const LedgerSnapshot = Schema.Struct({
  since: Schema.NullOr(counter),
  degraded: Schema.Boolean,
  totals: Schema.Array(UsageTotal),
  recent: Schema.Array(UsageAttempt)
})
export type LedgerSnapshot = typeof LedgerSnapshot.Type
export class UsageUnavailable extends Schema.TaggedError<UsageUnavailable>()("UsageUnavailable", {
  diagnostic: FailureDiagnostic
}) {}
export const usageUnavailable = (reason: "Storage" | "InvalidSchema" = "Storage") =>
  new UsageUnavailable({ diagnostic: { category: "Runtime", reason } })
/** Accounting is durable product data; operational audit is never its storage. */
export class UsageLedger extends Context.Service<
  UsageLedger,
  {
    readonly record: (attempt: UsageAttempt) => Effect.Effect<void, UsageUnavailable>
    readonly read: Effect.Effect<LedgerSnapshot, UsageUnavailable>
  }
>()("balabol/usage/ledger") {}
