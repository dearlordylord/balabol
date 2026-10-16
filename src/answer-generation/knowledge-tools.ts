import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import {
  Change,
  HostContext,
  KnowledgeRejected,
  KnowledgeReceipt,
  KnowledgeSnapshot,
  KnowledgeUnavailable,
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
      "Atomically introduce explicit types and create or update typed entities. Supply a reason. Operation identity is assigned by the host; never supply identity fields. Correct rejected changes before retrying.",
    parameters: Change.annotate(strict),
    success: KnowledgeReceipt,
    failure: failures,
    failureMode: "return"
  }).annotate(Tool.Strict, false),
  Tool.make("query_knowledge", {
    description: "Read typed personal entities by stable identity or type, with bounded pagination.",
    parameters: Query.annotate(strict),
    success: QueryPage,
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
    inspect_knowledge: () => knowledge.inspect(),
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
      }),
    query_knowledge: (query) => knowledge.query(query),
    inspect_knowledge_operations: (query) => knowledge.receipts({ ...query, inputDeliveryId: request.inputDeliveryId })
  })
export const acceptedKnowledgeOperations = (knowledge: typeof PersonalKnowledge.Service, request: AnswerRequest) =>
  knowledge.receipts({ inputDeliveryId: request.inputDeliveryId, limit: knowledgeLimits.receiptCount })
