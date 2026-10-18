import { Option, Schema, type Tracer } from "effect"
import { FailureDiagnostic } from "../failure-diagnostic/index.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u))
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const fields = {
  response: Hash,
  session: Hash,
  input: Hash,
  utterance: Hash,
  job: Hash,
  attempt: Hash,
  epoch: Hash,
  provider: FailureDiagnostic.fields.provider.schema,
  tool: FailureDiagnostic.fields.tool.schema,
  model: Schema.Literals(["gpt-6.1-sol", "gpt-6-luna"]),
  turn: Count,
  modelCalls: Count,
  toolCalls: Count,
  generation: Count,
  limit: Count,
  inputTokens: Count,
  outputTokens: Count,
  operation: Schema.Literals([
    "seal",
    "register",
    "begin",
    "abandon",
    "submit",
    "fence",
    "persist",
    "classify",
    "verify",
    "cancel",
    "release-lock"
  ]),
  resource: Schema.Literals([
    "capture",
    "connection",
    "output",
    "source",
    "session",
    "activity-process",
    "publication",
    "track"
  ]),
  policyLimit: FailureDiagnostic.fields.reason,
  failureHandling: Schema.Literals(["propagated", "returned-to-model", "returned-to-caller"]),
  finishReason: Schema.Literals(["model-stop", "budget-exhausted", "completed", "failed", "interrupted"])
}

/** Each field is validated independently; one malformed attribute cannot hide the others. */
export const auditAttributes = (span: Tracer.Span) =>
  Object.fromEntries(
    Object.entries(fields).flatMap(([key, schema]) => {
      const parsed = Schema.decodeUnknownOption(schema)(span.attributes.get(key))
      return Option.isSome(parsed) ? [[key, parsed.value]] : []
    })
  )
