import { createHash } from "node:crypto"
import { Effect, Redacted, Schema } from "effect"
import { withAuditSpan } from "../operation-audit/index.ts"

const maximumModels = 64
const billingWindowDays = 30
const fingerprintLength = 32
const unauthorizedStatus = 401
const forbiddenStatus = 403
const requestTimeoutMillis = 10000
const maximumBodyBytes = 1048576
const count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
const dollars = Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]*)(\.[0-9]{1,12})?$/))
export const SpeechUsage = Schema.Struct({
  model: Schema.NonEmptyString,
  total_api_cost_usd: dollars,
  total_num_requests: count,
  total_input_text_tokens: count,
  total_input_audio_tokens: count,
  total_output_text_tokens: count,
  total_output_audio_tokens: count,
  total_input_audio_duration_ms: count,
  total_output_audio_duration_ms: count
})
export const SpeechSnapshot = Schema.Struct({
  scope: Schema.String,
  status: Schema.Literals(["available", "notConfigured", "authentication", "permission", "unavailable"]),
  startTime: Schema.String,
  endTime: Schema.String,
  fetchedAt: count,
  models: Schema.Array(SpeechUsage).check(Schema.isMaxLength(maximumModels))
})
const Response = Schema.Struct({ models: Schema.Array(SpeechUsage).check(Schema.isMaxLength(maximumModels)) }).check(
  Schema.makeFilter((value) => new Set(value.models.map((model) => model.model)).size === value.models.length)
)
class BillingReadFailed extends Schema.TaggedError<BillingReadFailed>()("BillingReadFailed", {
  status: Schema.Literals(["authentication", "permission", "unavailable"]),
  reason: Schema.Literals(["Authentication", "Transport", "Protocol", "Limit", "Provider"]),
  httpStatus: Schema.optionalKey(Schema.Number)
}) {
  readonly diagnostic = {
    category: "Runtime",
    reason: this.reason,
    provider: "soniox",
    ...(this.httpStatus === undefined ? {} : { status: this.httpStatus })
  } as const
}
export type UsageFetch = (url: string, init: RequestInit) => Promise<globalThis.Response>
/** Provider project totals, not an estimate or a claim of Balabol-only spend. */
export const sonioxUsage = (
  key: Redacted.Redacted<string> | undefined,
  now: number,
  fetcher: UsageFetch = fetch
): Effect.Effect<typeof SpeechSnapshot.Type> => {
  const end = new Date(now)
  const start = new Date(now)
  start.setUTCDate(start.getUTCDate() - billingWindowDays)
  start.setUTCHours(0, 0, 0, 0)
  const scope =
    key === undefined ? "" : createHash("sha256").update(Redacted.value(key)).digest("hex").slice(0, fingerprintLength)
  const base = { scope, startTime: start.toISOString(), endTime: end.toISOString(), fetchedAt: now, models: [] }
  if (key === undefined) return Effect.succeed({ ...base, status: "notConfigured" as const })
  const url = new URL("https://api.soniox.com/v1/usage/summary")
  url.searchParams.set("start_time", base.startTime)
  url.searchParams.set("end_time", base.endTime)
  return Effect.tryPromise({
    try: async (signal) => {
      const response = await fetcher(url.toString(), {
        redirect: "error",
        signal,
        headers: { Authorization: `Bearer ${Redacted.value(key)}` }
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new BillingReadFailed({
          reason:
            response.status === unauthorizedStatus || response.status === forbiddenStatus
              ? "Authentication"
              : "Provider",
          httpStatus: response.status,
          status:
            response.status === unauthorizedStatus
              ? "authentication"
              : response.status === forbiddenStatus
                ? "permission"
                : "unavailable"
        })
      }
      const data: unknown = await boundedJson(response)
      let parsed: typeof Response.Type
      try {
        parsed = Schema.decodeUnknownSync(Response)(data)
      } catch {
        throw new BillingReadFailed({ status: "unavailable", reason: "Protocol" })
      }
      return {
        ...base,
        status: "available" as const,
        models: parsed.models.filter((model) => /^(stt|tts)-/.test(model.model))
      }
    },
    catch: (error) =>
      error instanceof BillingReadFailed ? error : new BillingReadFailed({ status: "unavailable", reason: "Transport" })
  }).pipe(
    Effect.timeout(requestTimeoutMillis),
    withAuditSpan("usage.billing"),
    Effect.catch((error) =>
      Effect.succeed({ ...base, status: error instanceof BillingReadFailed ? error.status : ("unavailable" as const) })
    )
  )
}

async function boundedJson(response: globalThis.Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (reader === undefined) throw new BillingReadFailed({ status: "unavailable", reason: "Protocol" })
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      length += part.value.byteLength
      if (length > maximumBodyBytes) throw new BillingReadFailed({ status: "unavailable", reason: "Limit" })
      chunks.push(part.value)
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"))
    } catch {
      throw new BillingReadFailed({ status: "unavailable", reason: "Protocol" })
    }
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
}
