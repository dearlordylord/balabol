import { auditIdentity, withAuditSpan } from "../operation-audit/index.ts"
import { Effect } from "effect"
import { samePayload, type Memory, type DeliveryEvidence } from "../memory/index.ts"
import { DeliveryConflict, type SendMessage } from "./contracts.ts"
import type { Responses } from "./response-runtime.ts"
import type { Entry } from "./admission-state.ts"
import { selectResponseLanguage } from "./response-language.ts"

export const checkInputIdentity = (existing: DeliveryEvidence | undefined, message: SendMessage) => {
  const payload = existing?.state === "Accepted" ? existing.receipt : existing?.payload
  return payload !== undefined && (!samePayload(payload, { ...message, role: "user" }) || payload.role === "assistant")
    ? Effect.fail(new DeliveryConflict({ message: "Delivery identity already belongs to another payload" }))
    : Effect.void
}
export const persistInput = Effect.fn("Conversation.persistInput")(
  function* (memory: Memory["Service"], replies: Responses, entry: Entry, languages: readonly string[]) {
    const message = entry.message
    const existing = yield* memory.find(message.deliveryId)
    yield* checkInputIdentity(existing, message)
    if (existing?.state === "Accepted")
      return { receipt: existing.receipt, existing: entry.classification === "Existing" }
    const payload = existing?.payload
    yield* replies.admit("Interrupted", entry.result === "Failed" ? undefined : entry.originRevision)
    const receipt = yield* memory.append({
      ...message,
      role: "user",
      responseLanguage:
        payload?.responseLanguage ??
        selectResponseLanguage(message.languageSpans ?? [], message.detectedLanguage, languages)
    })
    return { receipt, existing: false }
  },
  (effect, _memory, _replies, entry) =>
    effect.pipe(
      withAuditSpan("conversation.admission", undefined, {
        operation: "persist",
        input: auditIdentity(entry.message.deliveryId)
      })
    )
)

/** Classification reports storage evidence to the owner; it never creates fresh intent itself. */
export const classifyInput = (memory: Memory["Service"], entry: Entry) =>
  memory.find(entry.message.deliveryId).pipe(
    Effect.tap((evidence) => checkInputIdentity(evidence, entry.message)),
    Effect.map((evidence) => ({ kind: "Classified" as const, operation: entry.core.operation, evidence })),
    withAuditSpan("conversation.classify", undefined, { input: auditIdentity(entry.message.deliveryId) }),
    Effect.catch((error) => Effect.succeed({ kind: "Failed" as const, operation: entry.core.operation, error })),
    Effect.uninterruptible
  )
