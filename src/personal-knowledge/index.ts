import type { DatabaseSync } from "node:sqlite"
import { Context, Effect, Layer, Schema } from "effect"

// This slice has an explicit empty catalog; schema mutations belong to the next capability.
export const KnowledgeSchema = Schema.Struct({ types: Schema.Tuple([]), relations: Schema.Tuple([]) })
export type KnowledgeSchema = typeof KnowledgeSchema.Type
export const KnowledgeSnapshot = Schema.Struct({
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  schema: KnowledgeSchema
})
export type KnowledgeSnapshot = typeof KnowledgeSnapshot.Type

export class KnowledgeUnavailable extends Schema.TaggedError<KnowledgeUnavailable>()("KnowledgeUnavailable", {
  message: Schema.String
}) {}

export class PersonalKnowledge extends Context.Service<
  PersonalKnowledge,
  { inspect: () => Effect.Effect<KnowledgeSnapshot, KnowledgeUnavailable> }
>()("balabol/personal-knowledge") {}

const maximumSnapshotBytes = 16_384
const StoredSnapshot = Schema.Struct({ format: Schema.Literal(1), payload: Schema.String })
const unavailable = () => new KnowledgeUnavailable({ message: "Personal knowledge is unavailable" })

const inspect = (database: DatabaseSync): KnowledgeSnapshot => {
  const row = Schema.decodeUnknownSync(StoredSnapshot)(
    database
      .prepare(
        "SELECT format, CASE WHEN length(CAST(payload AS BLOB))<=? THEN payload ELSE NULL END AS payload FROM personal_knowledge_snapshot WHERE id=1"
      )
      .get(maximumSnapshotBytes)
  )
  const snapshot = Schema.decodeUnknownSync(KnowledgeSnapshot, { onExcessProperty: "error" })(JSON.parse(row.payload))
  Object.freeze(snapshot.schema.types)
  Object.freeze(snapshot.schema.relations)
  Object.freeze(snapshot.schema)
  return Object.freeze(snapshot)
}

/** The composition root owns this borrowed database's acquisition, durability settings and release. */
export const sqliteKnowledgeLayer = (database: DatabaseSync) =>
  Layer.effect(
    PersonalKnowledge,
    Effect.try({
      try: () => {
        database.exec(
          "CREATE TABLE IF NOT EXISTS personal_knowledge_snapshot(id INTEGER PRIMARY KEY CHECK(id=1), format INTEGER NOT NULL, payload TEXT NOT NULL)"
        )
        const initial: KnowledgeSnapshot = { revision: 0, schema: { types: [], relations: [] } }
        database
          .prepare("INSERT OR IGNORE INTO personal_knowledge_snapshot(id,format,payload) VALUES(1,1,?)")
          .run(Schema.encodeSync(Schema.fromJsonString(KnowledgeSnapshot))(initial))
        inspect(database)
        return PersonalKnowledge.of({ inspect: () => Effect.try({ try: () => inspect(database), catch: unavailable }) })
      },
      catch: unavailable
    })
  )
