import type { VoiceFailed } from "./contracts.ts"
import type { RecognitionFailureReason } from "../speech-recognition/index.ts"
import type { SessionState, SessionEventInput } from "./session-state.ts"
import type { SessionCommand } from "./session-events.ts"
import type { OutputDecision } from "./output-state.ts"
const maximumEvents = 100
const maximumEventBytes = 256000
export interface SessionTransition {
  readonly state: SessionState
  readonly commands: readonly SessionCommand[]
  readonly error?: VoiceFailed
  readonly outputDecision?: OutputDecision
}
export const unchanged = (state: SessionState): SessionTransition => ({ state, commands: [] })
export const emit = (
  state: SessionState,
  input: SessionEventInput,
  recognitionReason?: typeof RecognitionFailureReason.Type
): SessionTransition => {
  const event = { ...input, sessionId: state.id, sequence: state.sequence + 1 }
  let events = [...state.events, event]
  while (events.length > maximumEvents || new TextEncoder().encode(JSON.stringify(events)).length > maximumEventBytes)
    events = events.slice(1)
  const publish: readonly SessionCommand[] = state.phase === "active" ? [{ kind: "Publish", event }] : []
  const trace: readonly SessionCommand[] =
    event.kind === "Error" || event.kind === "Discarded"
      ? [{ kind: "TraceEvent", event, ...(recognitionReason === undefined ? {} : { recognitionReason }) }]
      : []
  return { state: { ...state, events, sequence: event.sequence }, commands: [...publish, ...trace] }
}
