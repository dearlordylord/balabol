import { Context, Effect, Layer, Schema, Semaphore } from "effect"
import { DurableKnowledge } from "./durable-port.ts"
import { boundedKnowledge, nextRevision, parseChange, queryRevision, recoverOutcome, rejectUnknown } from "./domain.ts"
import {
  type Change,
  HostContext,
  type KnowledgeReceipt,
  KnowledgeRejected,
  type KnowledgeRevision,
  type KnowledgeSnapshot,
  type KnowledgeUnavailable,
  Query,
  type QueryPage,
  type ReceiptPage,
  ReceiptQuery,
  freezeKnowledge,
  knowledgeLimits
} from "./models.ts"

type Failure = KnowledgeRejected | KnowledgeUnavailable
export class PersonalKnowledge extends Context.Service<
  PersonalKnowledge,
  {
    inspect: () => Effect.Effect<KnowledgeSnapshot, KnowledgeUnavailable>
    query: (query: Query) => Effect.Effect<QueryPage, Failure>
    apply: (change: Change, context: HostContext) => Effect.Effect<KnowledgeReceipt, Failure>
    receipts: (query: ReceiptQuery) => Effect.Effect<ReceiptPage, Failure>
    revision: (revision: number) => Effect.Effect<KnowledgeRevision, Failure>
  }
>()("balabol/personal-knowledge") {}
const checked = <A>(evaluate: () => A) => Effect.try({ try: evaluate, catch: rejectUnknown })
const decodeQuery = Schema.decodeUnknownSync(Query, { onExcessProperty: "error" })
const decodeContext = Schema.decodeUnknownSync(HostContext, { onExcessProperty: "error" })
const decodeReceipts = Schema.decodeUnknownSync(ReceiptQuery, { onExcessProperty: "error" })
const RevisionNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** One backend-scoped layer owns the global mutation lock; inference never holds it. */
export const personalKnowledgeLayer = Layer.effect(
  PersonalKnowledge,
  Effect.gen(function* () {
    const durable = yield* DurableKnowledge
    const lock = yield* Semaphore.make(1)
    return PersonalKnowledge.of({
      inspect: () => durable.current().pipe(Effect.map((current) => current.snapshot)),
      query: (raw) =>
        Effect.gen(function* () {
          const query = yield* checked(() => decodeQuery(raw))
          const current = yield* durable.current()
          return yield* checked(() => queryRevision(current, query))
        }),
      apply: (rawChange, rawContext) =>
        Effect.gen(function* () {
          const change = yield* checked(() => parseChange(rawChange))
          const context = yield* checked(() => decodeContext(rawContext))
          const previous = yield* durable.lookup({
            inputDeliveryId: context.inputDeliveryId,
            operationId: context.operationId
          })
          if (previous !== undefined)
            return yield* checked(() => recoverOutcome(previous.change, change, previous.receipt))
          const current = yield* durable.current()
          const revision = yield* checked(() => nextRevision(current, change, context))
          return yield* durable.commit({ expectedRevision: current.snapshot.revision, revision, change })
        }).pipe(lock.withPermits(1)),
      receipts: (raw) =>
        Effect.gen(function* () {
          const query = yield* checked(() => decodeReceipts(raw))
          const page = yield* durable.receiptsByInput(query)
          return yield* checked(() => {
            boundedKnowledge(page, knowledgeLimits.receiptBytes, "Receipt page")
            freezeKnowledge(page)
            return page
          })
        }),
      revision: (raw) =>
        Effect.gen(function* () {
          const number = yield* checked(() => Schema.decodeUnknownSync(RevisionNumber)(raw))
          const revision = yield* durable.revision(number)
          if (revision === undefined)
            return yield* Effect.fail(
              new KnowledgeRejected({
                code: "RevisionNotFound",
                message: `Knowledge revision ${number} does not exist`
              })
            )
          return revision
        })
    })
  })
)
