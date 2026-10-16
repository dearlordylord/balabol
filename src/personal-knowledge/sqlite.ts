import type { DatabaseSync } from "node:sqlite"
import { Effect, Layer, Schema } from "effect"
import { DurableKnowledge } from "./durable-port.ts"
import {
  type Change,
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
  StoredOutcome,
  changeIdentity,
  freezeKnowledge,
  knowledgeLimits
} from "./models.ts"

const Payload = Schema.Struct({ payload: Schema.String })
const currentFormat = 2
const beforeFirstRevision = -1
const Head = Schema.Struct({ format: Schema.Literals([1, currentFormat]), payload: Schema.String })
const RevisionNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Legacy = Schema.Struct({
  revision: Schema.Literal(0),
  schema: Schema.Struct({ types: Schema.Tuple([]), relations: Schema.Tuple([]) })
})
const unavailable = () => new KnowledgeUnavailable({ message: "Personal knowledge is unavailable" })
const rejected = (message: string) => new KnowledgeRejected({ code: "IdentityConflict", message })
const bytes = (value: string) => Buffer.byteLength(value, "utf8")

const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, row: unknown): S["Type"] => {
  const value = Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(
    JSON.parse(Schema.decodeUnknownSync(Payload)(row).payload)
  )
  freezeKnowledge(value)
  return value
}
const encodeRevision = (revision: KnowledgeRevision): string => {
  const payload = Schema.encodeSync(Schema.fromJsonString(KnowledgeRevision))(revision)
  if (bytes(payload) > knowledgeLimits.stateBytes) throw unavailable()
  return payload
}
const transaction = <A>(database: DatabaseSync, action: () => A): A => {
  database.exec("BEGIN IMMEDIATE")
  try {
    const result = action()
    database.exec("COMMIT")
    return result
  } catch (error) {
    database.exec("ROLLBACK")
    throw error
  }
}
const readHead = (database: DatabaseSync) =>
  Schema.decodeUnknownSync(Head)(
    database
      .prepare(
        "SELECT format, CASE WHEN length(CAST(payload AS BLOB))<=? THEN payload ELSE NULL END AS payload FROM personal_knowledge_snapshot WHERE id=1"
      )
      .get(knowledgeLimits.stateBytes)
  )
const readRevision = (database: DatabaseSync, revision: number): KnowledgeRevision | undefined => {
  Schema.decodeUnknownSync(RevisionNumber)(revision)
  const row = database
    .prepare(
      "SELECT CASE WHEN length(CAST(payload AS BLOB))<=? THEN payload ELSE NULL END AS payload FROM personal_knowledge_revisions WHERE revision=?"
    )
    .get(knowledgeLimits.stateBytes, revision)
  if (row === undefined) return undefined
  const value = decode(KnowledgeRevision, row)
  if (value.snapshot.revision !== revision) throw unavailable()
  if (value.receipt !== null && value.receipt.revision !== revision) throw unavailable()
  if ((revision === 0) !== (value.receipt === null)) throw unavailable()
  return value
}
const current = (database: DatabaseSync): KnowledgeRevision => {
  const head = readHead(database)
  if (head.format !== currentFormat) throw unavailable()
  const revision = decode(KnowledgeRevision, head)
  const historical = readRevision(database, revision.snapshot.revision)
  if (historical === undefined || JSON.stringify(historical) !== JSON.stringify(revision)) throw unavailable()
  return revision
}
const lookup = (database: DatabaseSync, identity: OperationIdentity): StoredOutcome | undefined => {
  const parsed = Schema.decodeUnknownSync(OperationIdentity, { onExcessProperty: "error" })(identity)
  const row = database
    .prepare(
      "SELECT CASE WHEN length(CAST(payload AS BLOB))<=? THEN payload ELSE NULL END AS payload FROM personal_knowledge_receipts WHERE inputDeliveryId=? AND operationId=?"
    )
    .get(knowledgeLimits.changeBytes + knowledgeLimits.receiptBytes, parsed.inputDeliveryId, parsed.operationId)
  if (row === undefined) return undefined
  const outcome = decode(StoredOutcome, row)
  if (
    outcome.receipt.context.inputDeliveryId !== parsed.inputDeliveryId ||
    outcome.receipt.context.operationId !== parsed.operationId
  )
    throw unavailable()
  return outcome
}
const receiptsByInput = (database: DatabaseSync, query: ReceiptQuery): ReceiptPage => {
  const parsed = Schema.decodeUnknownSync(ReceiptQuery, { onExcessProperty: "error" })(query)
  const rows = database
    .prepare(
      "SELECT CASE WHEN length(CAST(receipt AS BLOB))<=? THEN receipt ELSE NULL END AS payload FROM personal_knowledge_receipts WHERE inputDeliveryId=? AND revision>? ORDER BY revision LIMIT ?"
    )
    .all(
      knowledgeLimits.receiptBytes,
      parsed.inputDeliveryId,
      parsed.afterRevision ?? beforeFirstRevision,
      parsed.limit
    )
  const receipts = rows.map((row) => {
    const receipt = decode(KnowledgeReceipt, row)
    if (receipt.context.inputDeliveryId !== parsed.inputDeliveryId) throw unavailable()
    return receipt
  })
  const page = {
    receipts,
    nextAfterRevision: receipts.length === parsed.limit ? (receipts.at(beforeFirstRevision)?.revision ?? null) : null
  }
  if (bytes(JSON.stringify(page)) > knowledgeLimits.receiptBytes) throw unavailable()
  const result = Schema.decodeUnknownSync(ReceiptPage)(page)
  freezeKnowledge(result)
  return result
}
const HistoryRow = Schema.Struct({ revision: RevisionNumber, payload: Schema.NullOr(Schema.String) })
const history = (database: DatabaseSync, query: RevisionQuery): RevisionPage => {
  const parsed = Schema.decodeUnknownSync(RevisionQuery, { onExcessProperty: "error" })(query)
  const rows = database
    .prepare(
      "SELECT versions.revision, CASE WHEN length(CAST(outcomes.receipt AS BLOB))<=? THEN outcomes.receipt ELSE NULL END AS payload FROM personal_knowledge_revisions AS versions LEFT JOIN personal_knowledge_receipts AS outcomes ON outcomes.revision=versions.revision WHERE versions.revision>? AND versions.revision<=? ORDER BY versions.revision LIMIT ?"
    )
    .all(
      knowledgeLimits.receiptBytes,
      parsed.afterRevision ?? beforeFirstRevision,
      parsed.throughRevision ?? Number.MAX_SAFE_INTEGER,
      parsed.limit + 1
    )
  const revisions = rows.slice(0, parsed.limit).map((raw) => {
    const row = Schema.decodeUnknownSync(HistoryRow)(raw)
    if (row.revision === 0) return { revision: 0, reason: null, context: null }
    if (row.payload === null) throw unavailable()
    const receipt = decode(KnowledgeReceipt, row)
    if (receipt.revision !== row.revision) throw unavailable()
    return { revision: row.revision, reason: receipt.reason, context: receipt.context }
  })
  const result = Schema.decodeUnknownSync(RevisionPage)({
    revisions,
    nextAfterRevision: rows.length > parsed.limit ? (revisions.at(beforeFirstRevision)?.revision ?? null) : null
  })
  if (bytes(JSON.stringify(result)) > knowledgeLimits.receiptBytes) throw unavailable()
  freezeKnowledge(result)
  return result
}
const persist = (database: DatabaseSync, revision: KnowledgeRevision, change: Change): KnowledgeReceipt => {
  const receipt = revision.receipt
  if (receipt === null || receipt.revision !== revision.snapshot.revision || receipt.reason !== change.reason)
    throw unavailable()
  const payload = encodeRevision(revision)
  const outcome = Schema.encodeSync(Schema.fromJsonString(StoredOutcome))({ receipt, change })
  database
    .prepare("INSERT INTO personal_knowledge_revisions(revision,payload) VALUES(?,?)")
    .run(revision.snapshot.revision, payload)
  database.prepare("UPDATE personal_knowledge_snapshot SET format=2,payload=? WHERE id=1").run(payload)
  database
    .prepare(
      "INSERT INTO personal_knowledge_receipts(inputDeliveryId,operationId,revision,payload,receipt) VALUES(?,?,?,?,?)"
    )
    .run(
      receipt.context.inputDeliveryId,
      receipt.context.operationId,
      receipt.revision,
      outcome,
      JSON.stringify(receipt)
    )
  return receipt
}
const commit = (database: DatabaseSync, request: CommitRequest): KnowledgeReceipt =>
  transaction(database, () => {
    const parsed = Schema.decodeUnknownSync(CommitRequest, { onExcessProperty: "error" })(request)
    if (bytes(JSON.stringify(parsed.change)) > knowledgeLimits.changeBytes) throw unavailable()
    const receipt = parsed.revision.receipt
    if (receipt === null) throw unavailable()
    const existing = lookup(database, {
      inputDeliveryId: receipt.context.inputDeliveryId,
      operationId: receipt.context.operationId
    })
    if (existing !== undefined) {
      if (changeIdentity(existing.change) !== changeIdentity(parsed.change))
        throw rejected("Operation identity already belongs to a different change")
      return existing.receipt
    }
    const head = current(database)
    if (
      head.snapshot.revision !== parsed.expectedRevision ||
      parsed.revision.snapshot.revision !== parsed.expectedRevision + 1
    )
      throw rejected("Knowledge revision changed; inspect the current schema before retrying")
    return persist(database, parsed.revision, parsed.change)
  })
const initialize = (database: DatabaseSync): void =>
  transaction(database, () => {
    database.exec(
      "CREATE TABLE IF NOT EXISTS personal_knowledge_snapshot(id INTEGER PRIMARY KEY CHECK(id=1),format INTEGER NOT NULL,payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS personal_knowledge_revisions(revision INTEGER PRIMARY KEY CHECK(revision>=0),payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS personal_knowledge_receipts(inputDeliveryId TEXT NOT NULL,operationId TEXT NOT NULL,revision INTEGER NOT NULL UNIQUE REFERENCES personal_knowledge_revisions(revision),payload TEXT NOT NULL,receipt TEXT NOT NULL,PRIMARY KEY(inputDeliveryId,operationId)); CREATE INDEX IF NOT EXISTS personal_knowledge_receipts_by_input_revision ON personal_knowledge_receipts(inputDeliveryId,revision)"
    )
    const present = database.prepare("SELECT id FROM personal_knowledge_snapshot WHERE id=1").get()
    if (present === undefined) {
      const orphan = database.prepare("SELECT revision FROM personal_knowledge_revisions LIMIT 1").get()
      if (orphan !== undefined) throw unavailable()
      const initial: KnowledgeRevision = {
        snapshot: { revision: 0, schema: { types: [], relations: [] } },
        entities: [],
        relations: [],
        receipt: null
      }
      database
        .prepare("INSERT INTO personal_knowledge_snapshot(id,format,payload) VALUES(1,2,?)")
        .run(encodeRevision(initial))
      database
        .prepare("INSERT INTO personal_knowledge_revisions(revision,payload) VALUES(0,?)")
        .run(encodeRevision(initial))
    }
    const head = readHead(database)
    if (head.format === 1) {
      const snapshot = decode(Legacy, head)
      const revision: KnowledgeRevision = { snapshot, entities: [], relations: [], receipt: null }
      const payload = encodeRevision(revision)
      database.prepare("INSERT INTO personal_knowledge_revisions(revision,payload) VALUES(0,?)").run(payload)
      database.prepare("UPDATE personal_knowledge_snapshot SET format=2,payload=? WHERE id=1").run(payload)
    }
    current(database)
  })

/** Borrows the composition's leased WAL/FULL database; never acquires or closes a second resource. */
export const durableKnowledgeLayer = (database: DatabaseSync) =>
  Layer.effect(
    DurableKnowledge,
    Effect.try({
      try: () => {
        initialize(database)
        return DurableKnowledge.of({
          history: (query) => Effect.try({ try: () => history(database, query), catch: unavailable }),
          current: () => Effect.try({ try: () => current(database), catch: unavailable }),
          revision: (revision) => Effect.try({ try: () => readRevision(database, revision), catch: unavailable }),
          receiptsByInput: (query) => Effect.try({ try: () => receiptsByInput(database, query), catch: unavailable }),
          lookup: (identity) => Effect.try({ try: () => lookup(database, identity), catch: unavailable }),
          commit: (request) =>
            Effect.try({
              try: () => commit(database, request),
              catch: (error) => (error instanceof KnowledgeRejected ? error : unavailable())
            })
        })
      },
      catch: unavailable
    })
  )
