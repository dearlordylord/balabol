import { Cause, Option, Schema } from "effect"
import { DeliveryFailure, FailureReason } from "../delivery-failure/index.ts"
import { FailureDiagnostic } from "../failure-diagnostic/index.ts"

const maximumCauses = 8
const FailureCode = Schema.Union([
  DeliveryFailure.fields.code,
  Schema.Literals([
    "SpeechSynthesisFailed",
    "RecognitionFailed",
    "AnswerFailed",
    "VoiceFailed",
    "SummaryFailed",
    "InferenceFailed",
    "SubscriptionFailed",
    "KnowledgeRejected",
    "KnowledgeUnavailable",
    "DictionaryRejected",
    "DictionaryUnavailable",
    "InvalidInput",
    "AdmissionConflict",
    "ReplyBusy",
    "ReplyNotFound"
  ])
])
// Accessors and raw exception text are never evaluated by the exporter.
const own = (value: object, key: string): unknown => Object.getOwnPropertyDescriptor(value, key)?.value
const parsed = <A>(schema: Schema.ConstraintDecoder<A>, value: unknown) =>
  Option.getOrUndefined(Schema.decodeUnknownOption(schema)(value))
const explicitDiagnostic = (value: object) => {
  const diagnostic = own(value, "diagnostic")
  if (typeof diagnostic !== "object" || diagnostic === null) return undefined
  return parsed(
    FailureDiagnostic,
    Object.fromEntries(
      Object.keys(FailureDiagnostic.fields)
        .map((key) => [key, own(diagnostic, key)])
        .filter(([, entry]) => entry !== undefined)
    )
  )
}
const categories: Readonly<Record<string, FailureDiagnostic["category"]>> = {
  InferenceFailed: "Subscription",
  SubscriptionFailed: "Subscription",
  KnowledgeRejected: "Knowledge",
  KnowledgeUnavailable: "Knowledge",
  DictionaryRejected: "Dictionary",
  DictionaryUnavailable: "Dictionary",
  RecognitionFailed: "Recognition",
  SpeechSynthesisFailed: "Synthesis",
  StorageUnavailable: "Memory",
  VoiceFailed: "Media",
  SummaryFailed: "Memory",
  MemoryPending: "Memory",
  MemoryFailed: "Memory",
  AudioUnavailable: "Media",
  ProviderFailed: "Agent",
  InvalidProviderStream: "Agent",
  InvalidInput: "Lifecycle",
  AdmissionConflict: "Lifecycle",
  Restarted: "Lifecycle",
  Cancelled: "Lifecycle",
  ReplyBusy: "Lifecycle",
  ReplyNotFound: "Lifecycle"
}
const fallbackReasons: Readonly<Record<string, FailureDiagnostic["reason"]>> = {
  StorageUnavailable: "Storage",
  MemoryPending: "Unavailable",
  MemoryFailed: "Failed",
  AudioUnavailable: "Unavailable",
  ProviderFailed: "ProviderFailure",
  InvalidProviderStream: "Protocol",
  InvalidInput: "InvalidRequest",
  AdmissionConflict: "IdentityConflict",
  Restarted: "Unavailable",
  Cancelled: "Unavailable",
  ReplyBusy: "Unavailable",
  ReplyNotFound: "Missing"
}
const legacyReason = (value: object, tag: string | undefined) =>
  own(value, "reason") ??
  own(value, "kind") ??
  (tag === undefined ? undefined : fallbackReasons[tag]) ??
  own(value, "code") ??
  "Unavailable"
const legacyDiagnostic = (value: object) => {
  const tag = parsed(FailureCode, own(value, "_tag")) ?? parsed(FailureCode, own(value, "code"))
  const category = typeof tag === "string" ? categories[tag] : undefined
  if (category === undefined) return undefined
  const reason = legacyReason(value, tag)
  return parsed(FailureDiagnostic, { category, reason })
}
const typedFields = (value: unknown) => {
  if (typeof value !== "object" || value === null)
    return { diagnostic: { category: "Runtime", reason: "UnknownFailure" } }
  const code = parsed(FailureCode, own(value, "code")) ?? parsed(FailureCode, own(value, "_tag"))
  const reason = parsed(FailureReason, own(value, "reason"))
  const diagnostic = explicitDiagnostic(value) ??
    legacyDiagnostic(value) ?? { category: "Runtime", reason: "UnknownFailure" }
  return { code, reason, diagnostic }
}
const causeRecord = (reason: Cause.Reason<unknown>) => {
  if (Cause.isFailReason(reason)) return { kind: "Fail", ...typedFields(reason.error) }
  if (Cause.isDieReason(reason)) return { kind: "Die", diagnostic: { category: "Runtime", reason: "UnexpectedDefect" } }
  return { kind: "Interrupt" }
}
export const auditFailures = (cause: Cause.Cause<unknown>) => ({
  ...Option.match(Cause.findErrorOption(cause), { onNone: () => ({}), onSome: typedFields }),
  ...(Cause.hasDies(cause) ? { diagnostic: { category: "Runtime", reason: "UnexpectedDefect" } } : {}),
  failures: cause.reasons.slice(0, maximumCauses).map(causeRecord),
  causesDropped: Math.max(0, cause.reasons.length - maximumCauses)
})
