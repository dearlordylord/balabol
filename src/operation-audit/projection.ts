import { Cause, Exit, Option, Schema, type Tracer } from "effect"
import { DeliveryFailure, FailureReason } from "../delivery-failure/index.ts"
const nanosPerMilli = 1000000
const Name = Schema.Literals([
  "conversation.response",
  "voice.recognition",
  "voice.eventDelivery",
  "voice.settlement",
  "voice.unregister",
  "conversation.context",
  "conversation.answer",
  "conversation.persist",
  "voice.synthesis",
  "voice.publication",
  "voice.capture",
  "voice.drain",
  "voice.ready",
  "voice.readyWait",
  "voice.reply",
  "voice.failure",
  "speech.plan",
  "speech.render",
  "speech.convert"
])
const FailureCode = Schema.Union([
  DeliveryFailure.fields.code,
  Schema.Literals(["SpeechSynthesisFailed", "RecognitionFailed", "AnswerFailed", "VoiceFailed"])
])
const codeField = (value: object) => {
  const code = "code" in value ? value.code : "_tag" in value ? value._tag : undefined
  return Option.getOrUndefined(Schema.decodeUnknownOption(FailureCode)(code))
}
const errorFields = (cause: Cause.Cause<unknown>) => {
  const error = Cause.findErrorOption(cause)
  if (Option.isNone(error) || typeof error.value !== "object" || error.value === null) return {}
  return Schema.decodeUnknownSync(
    Schema.Struct({ reason: Schema.optional(FailureReason), code: Schema.optional(FailureCode) })
  )({
    reason:
      "reason" in error.value
        ? Option.getOrUndefined(Schema.decodeUnknownOption(FailureReason)(error.value.reason))
        : undefined,
    code: codeField(error.value)
  })
}
const outcome = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return "Succeeded"
  if (Cause.hasDies(exit.cause)) return "Defect"
  return Cause.hasInterruptsOnly(exit.cause) ? "Cancelled" : "Failed"
}
const responseField = (span: Tracer.Span) => {
  const value = span.attributes.get("response")
  return typeof value === "string" && /^[a-f0-9]{32}$/.test(value) ? { response: value } : {}
}
export const auditRecord = (span: Tracer.Span, time: bigint, exit: Exit.Exit<unknown, unknown>, wallTime: number) => {
  if (Option.isNone(Schema.decodeUnknownOption(Name)(span.name))) return undefined
  if (span.name === "voice.eventDelivery" && Exit.isSuccess(exit)) return undefined
  return {
    at: wallTime,
    name: span.name,
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: Option.getOrUndefined(Option.map(span.parent, (parent) => parent.spanId)),
    durationMillis: Number(time - span.status.startTime) / nanosPerMilli,
    outcome: outcome(exit),
    ...responseField(span),
    ...(Exit.isFailure(exit) ? errorFields(exit.cause) : {})
  }
}
