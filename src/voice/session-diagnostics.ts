import { diagnosticErrorCode, recordVoiceDiagnostic } from "./diagnostics.ts"
import type { VoiceDiagnostics } from "./diagnostics.ts"
import type { SessionState } from "./session-state.ts"
import type { SessionCommand } from "./session-events.ts"
export const recordSessionEventDiagnostic = (
  diagnostics: VoiceDiagnostics["Service"],
  state: SessionState,
  command: Extract<SessionCommand, { kind: "TraceEvent" }>
) => {
  const event = command.event
  if (event.kind !== "Error" && event.kind !== "Discarded") return
  recordVoiceDiagnostic(diagnostics, {
    cause: event.kind === "Error" ? "sessionError" : "recognitionDiscarded",
    sessionId: state.id,
    generation: state.generation,
    applied: true,
    ...(event.kind === "Error" ? { errorCode: diagnosticErrorCode(event.code) } : {}),
    ...(command.recognitionReason === undefined ? {} : { recognitionReason: command.recognitionReason })
  })
}
