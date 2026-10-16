import { Context, Effect, Layer, Schema, Semaphore } from "effect"
import { DurableKnowledge } from "./durable-port.ts"
import { boundedKnowledge, nextRevision, parseChange, recoverOutcome, rejectUnknown } from "./domain.ts"
import { neighborhoodRevision, queryRevision } from "./queries.ts"
import { differenceRevisions } from "./differences.ts"
import {
  type Change,
  DifferenceQuery,
  type DifferencePage,
  HostContext,
  type KnowledgeReceipt,
  KnowledgeRejected,
  type KnowledgeRevision,
  type KnowledgeSnapshot,
  type KnowledgeUnavailable,
  NeighborhoodQuery,
  type NeighborhoodPage,
  Query,
  type QueryPage,
  type ReceiptPage,
  ReceiptQuery,
  RevisionQuery,
  type RevisionPage,
  freezeKnowledge,
  knowledgeLimits
} from "./models.ts"

type Failure = KnowledgeRejected | KnowledgeUnavailable
export class PersonalKnowledge extends Context.Service<
  PersonalKnowledge,
  {
    inspect: () => Effect.Effect<KnowledgeSnapshot, KnowledgeUnavailable>
    query: (query: Query) => Effect.Effect<QueryPage, Failure>
    neighborhood: (query: NeighborhoodQuery) => Effect.Effect<NeighborhoodPage, Failure>
    apply: (change: Change, context: HostContext) => Effect.Effect<KnowledgeReceipt, Failure>
    receipts: (query: ReceiptQuery) => Effect.Effect<ReceiptPage, Failure>
    revision: (revision: number) => Effect.Effect<KnowledgeRevision, Failure>
    history: (query: RevisionQuery) => Effect.Effect<RevisionPage, Failure>
    difference: (query: DifferenceQuery) => Effect.Effect<DifferencePage, Failure>
  }
>()("balabol/personal-knowledge") {}
const checked = <A>(evaluate: () => A) => Effect.try({ try: evaluate, catch: rejectUnknown })
const decodeQuery = Schema.decodeUnknownSync(Query, { onExcessProperty: "error" })
const decodeNeighborhood = Schema.decodeUnknownSync(NeighborhoodQuery, { onExcessProperty: "error" })
const decodeContext = Schema.decodeUnknownSync(HostContext, { onExcessProperty: "error" })
const decodeReceipts = Schema.decodeUnknownSync(ReceiptQuery, { onExcessProperty: "error" })
const decodeHistory = Schema.decodeUnknownSync(RevisionQuery, { onExcessProperty: "error" })
const decodeDifference = Schema.decodeUnknownSync(DifferenceQuery, { onExcessProperty: "error" })
const RevisionNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** One backend-scoped layer owns the global mutation lock; inference never holds it. */
export const personalKnowledgeLayer = Layer.effect(
  PersonalKnowledge,
  Effect.gen(function* () {
    const durable = yield* DurableKnowledge
    const lock = yield* Semaphore.make(1)
    const historical = (number: number) =>
      durable
        .revision(number)
        .pipe(
          Effect.flatMap((revision) =>
            revision === undefined
              ? Effect.fail(
                  new KnowledgeRejected({
                    code: "RevisionNotFound",
                    message: `Knowledge revision ${number} does not exist`
                  })
                )
              : Effect.succeed(revision)
          )
        )
    const selectedRevision = (number: number | undefined) =>
      number === undefined ? durable.current() : historical(number)
    return PersonalKnowledge.of({
      inspect: () => durable.current().pipe(Effect.map((current) => current.snapshot)),
      query: (raw) =>
        Effect.gen(function* () {
          const query = yield* checked(() => decodeQuery(raw))
          const current = yield* selectedRevision(query.revision)
          return yield* checked(() => queryRevision(current, query))
        }),
      neighborhood: (raw) =>
        Effect.gen(function* () {
          const query = yield* checked(() => decodeNeighborhood(raw))
          const current = yield* selectedRevision(query.revision)
          return yield* checked(() => neighborhoodRevision(current, query))
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
          return yield* historical(number)
        }),
      history: (raw) =>
        Effect.gen(function* () {
          const query = yield* checked(() => decodeHistory(raw))
          const page = yield* durable.history(query)
          return yield* checked(() => {
            boundedKnowledge(page, knowledgeLimits.queryBytes, "Revision page")
            freezeKnowledge(page)
            return page
          })
        }),
      difference: (raw) =>
        Effect.gen(function* () {
          const query = yield* checked(() => decodeDifference(raw))
          const before = yield* historical(query.fromRevision)
          const after = yield* historical(query.toRevision)
          return yield* checked(() => differenceRevisions(before, after, query))
        })
    })
  })
)
