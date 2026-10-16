import { Context, type Effect } from "effect"
import type {
  CommitRequest,
  KnowledgeReceipt,
  KnowledgeRejected,
  KnowledgeRevision,
  KnowledgeUnavailable,
  OperationIdentity,
  ReceiptPage,
  ReceiptQuery,
  RevisionQuery,
  RevisionPage,
  StoredOutcome
} from "./models.ts"

/** Composition/test port; commit atomically retains state, history and the accepted outcome. */
export class DurableKnowledge extends Context.Service<
  DurableKnowledge,
  {
    history: (query: RevisionQuery) => Effect.Effect<RevisionPage, KnowledgeUnavailable>
    current: () => Effect.Effect<KnowledgeRevision, KnowledgeUnavailable>
    revision: (revision: number) => Effect.Effect<KnowledgeRevision | undefined, KnowledgeUnavailable>
    receiptsByInput: (query: ReceiptQuery) => Effect.Effect<ReceiptPage, KnowledgeUnavailable>
    lookup: (identity: OperationIdentity) => Effect.Effect<StoredOutcome | undefined, KnowledgeUnavailable>
    commit: (request: CommitRequest) => Effect.Effect<KnowledgeReceipt, KnowledgeRejected | KnowledgeUnavailable>
  }
>()("balabol/durable-knowledge") {}
