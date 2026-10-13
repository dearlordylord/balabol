import { Context, Effect, Layer, Schema } from "effect"

const SUMMARY_REQUEST_TEXT_LIMIT = 1000000
const IDENTIFIER_LIMIT = 200
const SUMMARY_OUTPUT_LIMIT = 100000
const PRIOR_RESPONSES_LIMIT = 100
const FAKE_SOURCE_PREVIEW_LIMIT = 80

// Grounding: @firfi/unii 0.1.0 CompressionRequest (src/types.ts), and
// its memory.ts #run: attempts start at 1; source/context can be empty.
// research/subscription-model-integration.md: summaries expose no tools and
// only a complete response is successful; unii owns acceptance and retries.
const BoundedText = Schema.String.check(Schema.isMaxLength(SUMMARY_REQUEST_TEXT_LIMIT))
const Identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(IDENTIFIER_LIMIT))
const AddressPart = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const SummaryText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(SUMMARY_OUTPUT_LIMIT))

export const SummaryRequest = Schema.Struct({
  model: Identifier,
  jobId: Identifier,
  attemptId: Identifier,
  attempt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  node: Schema.Struct({ level: AddressPart, index: AddressPart }),
  source: BoundedText,
  context: BoundedText,
  priorResponses: Schema.Array(SummaryText).check(Schema.isMaxLength(PRIOR_RESPONSES_LIMIT)),
  feedback: Schema.NullOr(BoundedText)
})
export type SummaryRequest = typeof SummaryRequest.Type
export class SummaryFailed extends Schema.TaggedError<SummaryFailed>()("SummaryFailed", { message: Schema.String }) {}
export class SummaryGeneration extends Context.Service<
  SummaryGeneration,
  { summarize: (request: SummaryRequest) => Effect.Effect<string, SummaryFailed> }
>()("balabol/summary-generation") {}
export const fakeSummaryLayer = Layer.succeed(
  SummaryGeneration,
  SummaryGeneration.of({
    summarize: (raw) =>
      Schema.decodeUnknownEffect(SummaryRequest)(raw).pipe(
        Effect.mapError(() => new SummaryFailed({ message: "Invalid summary request" })),
        Effect.flatMap((request) =>
          Schema.encodeEffect(SummaryText)(
            `[Fake ${request.model} summary] ${request.source.slice(0, FAKE_SOURCE_PREVIEW_LIMIT)}`
          ).pipe(Effect.mapError(() => new SummaryFailed({ message: "Invalid completed summary" })))
        )
      )
  })
)
