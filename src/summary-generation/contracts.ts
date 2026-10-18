import { FailureDiagnostic } from "../failure-diagnostic/index.ts"
import { Context, Schema } from "effect"
import type { Effect } from "effect"
const SUMMARY_REQUEST_TEXT_LIMIT = 1000000
const IDENTIFIER_LIMIT = 200
const SUMMARY_OUTPUT_LIMIT = 100000
const PRIOR_RESPONSES_LIMIT = 100
const SOURCE_KINDS_LIMIT = 16
// Grounding: @firfi/unii 0.1.0 CompressionRequest (src/types.ts), and
// its memory.ts #run: attempts start at 1; source/context can be empty.
// research/subscription-model-integration.md: summaries expose no tools and
// only a complete response is successful; unii owns acceptance and retries.
const BoundedText = Schema.String.check(Schema.isMaxLength(SUMMARY_REQUEST_TEXT_LIMIT))
const Identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(IDENTIFIER_LIMIT))
const AddressPart = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const SummaryText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(SUMMARY_OUTPUT_LIMIT))

export const SummaryRequest = Schema.Struct({
  model: Identifier,
  jobId: Identifier,
  attemptId: Identifier,
  attempt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  node: Schema.Struct({ level: AddressPart, index: AddressPart }),
  source: BoundedText,
  sourceKinds: Schema.optionalKey(Schema.Array(Identifier).check(Schema.isMaxLength(SOURCE_KINDS_LIMIT))),
  context: BoundedText,
  priorResponses: Schema.Array(SummaryText).check(Schema.isMaxLength(PRIOR_RESPONSES_LIMIT)),
  feedback: Schema.NullOr(BoundedText)
})
export type SummaryRequest = typeof SummaryRequest.Type
export class SummaryFailed extends Schema.TaggedError<SummaryFailed>()("SummaryFailed", {
  diagnostic: Schema.optionalKey(FailureDiagnostic),
  message: Schema.String,
  retryable: Schema.optionalKey(Schema.Boolean)
}) {}
export class SummaryGeneration extends Context.Service<
  SummaryGeneration,
  { summarize: (request: SummaryRequest) => Effect.Effect<string, SummaryFailed> }
>()("balabol/summary-generation") {}
