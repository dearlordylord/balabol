import { withAuditSpan } from "../operation-audit/index.ts"
import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import {
  Change,
  HostContext,
  RevisionQuery,
  RevisionPage,
  DifferenceQuery,
  DifferencePage,
  KnowledgeRejected,
  KnowledgeReceipt,
  KnowledgeSnapshot,
  KnowledgeUnavailable,
  NeighborhoodQuery,
  NeighborhoodPage,
  type PersonalKnowledge,
  Query,
  QueryPage,
  ReceiptPage,
  ReceiptQuery,
  changeIdentity,
  knowledgeLimits
} from "../personal-knowledge/index.ts"
import type { AnswerRequest } from "./contracts.ts"

const strict = { parseOptions: { onExcessProperty: "error" as const } }
const failures = Schema.Union([KnowledgeRejected, KnowledgeUnavailable])
const OperationQuery = Schema.Struct({
  afterRevision: ReceiptQuery.fields.afterRevision,
  limit: ReceiptQuery.fields.limit
}).annotate(strict)
export const knowledgeTools = Toolkit.make(
  Tool.make("inspect_knowledge", {
    description: "Inspect the current explicit personal knowledge schema.",
    parameters: Schema.Struct({}).annotate(strict),
    success: KnowledgeSnapshot,
    failure: KnowledgeUnavailable
  }),
  Tool.make("apply_knowledge", {
    description:
      "Atomically introduce explicit types and create or update typed entities and relations with declared endpoint kinds. Use only supported AddField or RenameField migrations to evolve declared entity or relation fields atomically with ordinary writes. Required added fields need validated defaults for existing records. Supply a reason. Operation identity is assigned by the host; never supply identity fields. Correct rejected changes before retrying. Receipt updatedIds and updatedRelationIds report explicit writes; migration-affected identities and fields are available through paginated inspect_knowledge_difference, so empty receipt update lists do not mean a migration changed no records.",
    parameters: Change.annotate(strict),
    success: KnowledgeReceipt,
    failure: failures,
    failureMode: "return"
  }).annotate(Tool.Strict, false),
  Tool.make("query_knowledge", {
    description:
      "Read typed personal entities by stable identity, type or declared field values, with bounded pagination. Supply revision to read retained data against its original schema.",
    parameters: Query.annotate(strict),
    success: QueryPage,
    failure: failures,
    failureMode: "return"
  }).annotate(Tool.Strict, false),
  Tool.make("query_knowledge_neighborhood", {
    description:
      "Read a bounded one- or two-step relation neighborhood with stable identities, typed endpoint interpretation and explicit pagination or truncation. Supply revision for a matching historical schema and graph. Distinguish personal mnemonics from asserted translations using their declared relation types.",
    parameters: NeighborhoodQuery.annotate(strict),
    success: NeighborhoodPage,
    failure: failures,
    failureMode: "return"
  }).annotate(Tool.Strict, false),
  Tool.make("inspect_knowledge_history", {
    description:
      "List bounded retained knowledge revisions with their stored reasons and host context. Use the returned revision cursor to continue; this never reruns model calls or migrations.",
    parameters: RevisionQuery.annotate(strict),
    success: RevisionPage,
    failure: failures,
    failureMode: "return"
  }).annotate(Tool.Strict, false),
  Tool.make("inspect_knowledge_difference", {
    description:
      "Compare two retained knowledge revisions structurally, including schema changes, affected stable record IDs and changed field names. Use the returned cursor for bounded continuation.",
    parameters: DifferenceQuery.annotate(strict),
    success: DifferencePage,
    failure: failures,
    failureMode: "return"
  }).annotate(Tool.Strict, false),
  Tool.make("inspect_knowledge_operations", {
    description:
      "Read accepted knowledge operations for this current user input. Use the continuation cursor to recover earlier committed changes before submitting another change.",
    parameters: OperationQuery,
    success: ReceiptPage,
    failure: failures,
    failureMode: "return"
  }).annotate(Tool.Strict, false)
)

/** Identical decoded changes within one accepted input are one operation, independent of provider call IDs. */
export const knowledgeHandlers = (knowledge: typeof PersonalKnowledge.Service, request: AnswerRequest) =>
  knowledgeTools.toLayer({
    inspect_knowledge: () =>
      knowledge.inspect().pipe(withAuditSpan("agent.tool", request.responseId, { tool: "inspect_knowledge" })),
    apply_knowledge: (change) =>
      Effect.gen(function* () {
        const host = yield* Schema.decodeUnknownEffect(HostContext)({
          inputDeliveryId: request.inputDeliveryId,
          responseId: request.responseId,
          operationId: createHash("sha256").update(changeIdentity(change)).digest("hex")
        }).pipe(
          Effect.mapError(
            () =>
              new KnowledgeRejected({
                code: "IdentityConflict",
                message: "A valid host tool call identity is required"
              })
          )
        )
        return yield* knowledge.apply(change, host)
      }).pipe(withAuditSpan("agent.tool", request.responseId, { tool: "apply_knowledge" })),
    inspect_knowledge_history: (query) =>
      knowledge
        .history(query)
        .pipe(withAuditSpan("agent.tool", request.responseId, { tool: "inspect_knowledge_history" })),
    inspect_knowledge_difference: (query) =>
      knowledge
        .difference(query)
        .pipe(withAuditSpan("agent.tool", request.responseId, { tool: "inspect_knowledge_difference" })),
    query_knowledge: (query) =>
      knowledge.query(query).pipe(withAuditSpan("agent.tool", request.responseId, { tool: "query_knowledge" })),
    query_knowledge_neighborhood: (query) =>
      knowledge
        .neighborhood(query)
        .pipe(withAuditSpan("agent.tool", request.responseId, { tool: "query_knowledge_neighborhood" })),
    inspect_knowledge_operations: (query) =>
      knowledge
        .receipts({ ...query, inputDeliveryId: request.inputDeliveryId })
        .pipe(withAuditSpan("agent.tool", request.responseId, { tool: "inspect_knowledge_operations" }))
  })
export const acceptedKnowledgeOperations = (knowledge: typeof PersonalKnowledge.Service, request: AnswerRequest) =>
  knowledge.receipts({ inputDeliveryId: request.inputDeliveryId, limit: knowledgeLimits.receiptCount })
