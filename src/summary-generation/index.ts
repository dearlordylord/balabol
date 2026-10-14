import { Context, Effect, Layer, Schema } from "effect"

const SUMMARY_REQUEST_TEXT_LIMIT = 1000000
const IDENTIFIER_LIMIT = 200
const SUMMARY_OUTPUT_LIMIT = 100000
const PRIOR_RESPONSES_LIMIT = 100
const FAKE_SOURCE_PREVIEW_LIMIT = 80
const FAKE_NODE_BYTE_LIMIT = 512
const FAKE_MODEL_BYTE_LIMIT = 200
const INTERRUPTION_NOTE =
  "[Interrupted assistant output: generated text may not have been heard; no user agreement implied]"

function utf8Preview(text: string, byteLimit: number): string {
  let preview = ""
  let bytes = 0
  for (const character of text) {
    bytes += new TextEncoder().encode(character).byteLength
    if (bytes > byteLimit) break
    preview += character
  }
  return preview
}

function fakeSummary(request: SummaryRequest): string {
  // shortcut: controlled fake markers can occur in quoted text; use provenance-aware real summaries when integrating inference.
  const interrupted = request.source.includes("assistant_interrupted:") || request.source.includes(INTERRUPTION_NOTE)
  const note = interrupted ? ` ${INTERRUPTION_NOTE}` : ""
  const prefix = `[Fake ${utf8Preview(request.model, FAKE_MODEL_BYTE_LIMIT)} summary] `
  const available = FAKE_NODE_BYTE_LIMIT - new TextEncoder().encode(prefix + note).byteLength
  const sourcePreview = Array.from(request.source).slice(0, FAKE_SOURCE_PREVIEW_LIMIT).join("")
  return prefix + utf8Preview(sourcePreview, available) + note
}

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
export const FakeSummarySettings = Schema.Struct({
  failFirstJob: Schema.Boolean,
  delayMillis: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 60000 })),
  invalidCompletion: Schema.Boolean
})
export type FakeSummarySettings = typeof FakeSummarySettings.Type
export const configurableFakeSummaryLayer = (
  settings: FakeSummarySettings = { failFirstJob: false, delayMillis: 0, invalidCompletion: false }
) =>
  Layer.sync(SummaryGeneration, () => {
    const configuration = Schema.decodeUnknownSync(FakeSummarySettings)(settings)
    let failedJob: string | undefined
    return SummaryGeneration.of({
      summarize: (raw) =>
        Schema.decodeUnknownEffect(SummaryRequest)(raw).pipe(
          Effect.mapError(() => new SummaryFailed({ message: "Invalid summary request" })),
          Effect.flatMap((request) =>
            Effect.gen(function* () {
              yield* Effect.sleep(configuration.delayMillis)
              if (configuration.failFirstJob && failedJob === undefined) failedJob = request.jobId
              if (configuration.failFirstJob && request.jobId === failedJob)
                return yield* new SummaryFailed({ message: "Scripted first summary job failure" })
              return yield* Schema.encodeEffect(SummaryText)(
                configuration.invalidCompletion ? "" : fakeSummary(request)
              ).pipe(Effect.mapError(() => new SummaryFailed({ message: "Invalid completed summary" })))
            })
          )
        )
    })
  })
export const fakeSummaryLayer = configurableFakeSummaryLayer()
