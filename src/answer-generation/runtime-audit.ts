import type { RunEvent, RunCompleted, RunFailed, ToolCallFailed } from "@yielded/agent/run-event"
import { Effect, Schema } from "effect"
import { FailureDiagnostic } from "../failure-diagnostic/index.ts"
import { withAuditSpan } from "../operation-audit/index.ts"
import { AnswerFailed } from "./contracts.ts"
import { answerRuntimeDiagnostic } from "./subscription-failure.ts"
const terminalAttributes = (event: RunCompleted | RunFailed, toolCalls: number) => ({
  toolCalls,
  ...(event.usage === undefined
    ? {}
    : {
        modelCalls: event.usage.modelCalls,
        inputTokens: event.usage.inputTokens,
        outputTokens: event.usage.outputTokens
      }),
  finishReason: event._tag === "RunCompleted" ? event.finishReason : "failed",
  ...(event._tag === "RunCompleted" ? { turn: event.turns } : {})
})
const auditToolFailure = (event: ToolCallFailed, responseId: string) => {
  const tool = Schema.is(FailureDiagnostic.fields.tool)(event.toolName) ? event.toolName : undefined
  return Effect.fail(
    new AnswerFailed({
      message: "Agent tool failed",
      diagnostic: answerRuntimeDiagnostic(event.errorTag, event.message)
    })
  ).pipe(
    withAuditSpan("agent.tool", responseId, {
      ...(tool === undefined ? {} : { tool }),
      ...(event.failureHandling === undefined ? {} : { failureHandling: event.failureHandling })
    }),
    Effect.ignore
  )
}
/** Runtime rejections may happen before a handler; handler spans retain original domain failures. */
export const auditRuntimeEvent = (event: RunEvent, responseId: string, toolCalls: number) => {
  if (event._tag === "ToolCallFailed") return auditToolFailure(event, responseId)
  if (event._tag === "RunCompleted" || event._tag === "RunFailed")
    return Effect.annotateCurrentSpan(terminalAttributes(event, toolCalls))
  return Effect.void
}
