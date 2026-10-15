import { INTERRUPTION_NOTE } from "./provenance.ts"
import { SummaryGeneration, SummaryRequest, SummaryFailed, SummaryText } from "./contracts.ts"
import { Effect, Layer, Schema } from "effect"

const FAKE_SOURCE_PREVIEW_LIMIT = 80
const FAKE_NODE_BYTE_LIMIT = 512
const FAKE_MODEL_BYTE_LIMIT = 200

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

export { SummaryGeneration, SummaryRequest, SummaryFailed } from "./contracts.ts"
export { subscriptionSummaryLayer } from "./subscription.ts"
