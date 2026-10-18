import { Cause, Exit, Option, Schema, type Tracer } from "effect"
import { auditAttributes } from "./attributes.ts"
import { auditFailures } from "./failures.ts"
import { AuditSpanName } from "./contracts.ts"
const nanosPerMilli = 1000000

const outcome = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return "Succeeded"
  if (Cause.hasDies(exit.cause)) return "Defect"
  return Cause.hasInterruptsOnly(exit.cause) ? "Cancelled" : "Failed"
}
const quietSuccess = new Set([
  "voice.eventDelivery",
  "voice.capture",
  "voice.reply",
  "voice.activity",
  "voice.publish",
  "memory.pump"
])
export const auditRecord = (span: Tracer.Span, time: bigint, exit: Exit.Exit<unknown, unknown>, wallTime: number) => {
  if (Option.isNone(Schema.decodeUnknownOption(AuditSpanName)(span.name))) return undefined
  if (quietSuccess.has(span.name) && Exit.isSuccess(exit)) return undefined
  return {
    at: wallTime,
    name: span.name,
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: Option.getOrUndefined(Option.map(span.parent, (parent) => parent.spanId)),
    durationMillis: Number(time - span.status.startTime) / nanosPerMilli,
    outcome: outcome(exit),
    ...auditAttributes(span),
    ...(Exit.isFailure(exit) ? auditFailures(exit.cause) : {})
  }
}
