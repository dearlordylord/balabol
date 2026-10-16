import { DatabaseSync } from "node:sqlite"
import { Effect } from "effect"
import { expect, it } from "vitest"
import { SqliteMemoryStorage, sqliteStorageLayer } from "../src/memory/index.ts"
import { PersonalKnowledge, sqliteKnowledgeLayer, type Change } from "../src/personal-knowledge/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"

const inputDeliveryId = "11111111-1111-4111-8111-111111111111"
const responseId = "22222222-2222-4222-8222-222222222222"
const laterResponseId = "33333333-3333-4333-8333-333333333333"
const entityId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const context = { inputDeliveryId, responseId, operationId: "create-place" }
const change: Change = {
  reason: "Keep a named place",
  types: [{ name: "Place", fields: [{ name: "name", kind: "string", required: true }] }],
  creates: [{ id: entityId, type: "Place", values: { name: "Montréal" } }],
  updates: []
}
const opened = <A, E>(path: string, program: Effect.Effect<A, E, PersonalKnowledge>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { storage } = yield* SqliteMemoryStorage
        return yield* program.pipe(Effect.provide(sqliteKnowledgeLayer(storage.database)))
      }).pipe(Effect.provide(sqliteStorageLayer(path)))
    )
  )

it("rolls back current state and history when receipt persistence fails after intermediate writes", async () => {
  const database = await temporaryDatabase()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { storage } = yield* SqliteMemoryStorage
          yield* Effect.gen(function* () {
            const knowledge = yield* PersonalKnowledge
            storage.database.exec(
              "CREATE TEMP TRIGGER reject_knowledge_receipt BEFORE INSERT ON personal_knowledge_receipts BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END"
            )
            expect(yield* knowledge.apply(change, context).pipe(Effect.result)).toMatchObject({
              _tag: "Failure",
              failure: { _tag: "KnowledgeUnavailable" }
            })
            expect((yield* knowledge.inspect()).revision).toBe(0)
            expect((yield* knowledge.receipts({ inputDeliveryId, limit: 20 })).receipts).toEqual([])
            expect(yield* knowledge.revision(1).pipe(Effect.result)).toMatchObject({
              _tag: "Failure",
              failure: { code: "RevisionNotFound" }
            })
            storage.database.exec("DROP TRIGGER reject_knowledge_receipt")
            expect((yield* knowledge.apply(change, context)).revision).toBe(1)
          }).pipe(Effect.provide(sqliteKnowledgeLayer(storage.database)))
        })
      ).pipe(Effect.provide(sqliteStorageLayer(database.path)))
    )
    await opened(
      database.path,
      Effect.gen(function* () {
        const knowledge = yield* PersonalKnowledge
        expect((yield* knowledge.revision(1)).entities).toEqual(change.creates)
        expect((yield* knowledge.receipts({ inputDeliveryId, limit: 20 })).receipts).toHaveLength(1)
      })
    )
  } finally {
    await database.close()
  }
})

it("recovers accepted operation outcomes across reopen and rejects conflicting reuse without another revision", async () => {
  const database = await temporaryDatabase()
  try {
    const receipt = await opened(
      database.path,
      Effect.gen(function* () {
        const knowledge = yield* PersonalKnowledge
        return yield* knowledge.apply(change, context)
      })
    )
    await opened(
      database.path,
      Effect.gen(function* () {
        const knowledge = yield* PersonalKnowledge
        const recovered = yield* knowledge.apply(change, { ...context, responseId: laterResponseId })
        expect(recovered).toEqual(receipt)
        const conflict = yield* knowledge
          .apply({ ...change, reason: "Different intended change" }, context)
          .pipe(Effect.result)
        expect(conflict).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "KnowledgeRejected", code: "IdentityConflict" }
        })
        expect(yield* knowledge.inspect()).toMatchObject({ revision: 1 })
        expect(yield* knowledge.revision(0)).toEqual({
          snapshot: { revision: 0, schema: { types: [], relations: [] } },
          entities: [],
          receipt: null
        })
        expect(yield* knowledge.revision(1)).toEqual({
          snapshot: { revision: 1, schema: { types: change.types, relations: [] } },
          entities: change.creates,
          receipt
        })
        expect(yield* knowledge.receipts({ inputDeliveryId, limit: 1 })).toEqual({
          receipts: [receipt],
          nextAfterRevision: 1
        })
        expect(yield* knowledge.receipts({ inputDeliveryId, afterRevision: 1, limit: 1 })).toEqual({
          receipts: [],
          nextAfterRevision: null
        })
      })
    )
  } finally {
    await database.close()
  }
})

it("serializes concurrent mutations and retains the original schema and values for each revision", async () => {
  const database = await temporaryDatabase()
  try {
    await opened(
      database.path,
      Effect.gen(function* () {
        const knowledge = yield* PersonalKnowledge
        yield* knowledge.apply(change, context)
        const rename = (name: string, operationId: string) =>
          knowledge.apply(
            { reason: `Use ${name}`, types: [], creates: [], updates: [{ id: entityId, values: { name } }] },
            { ...context, operationId }
          )
        const outcomes = yield* Effect.all([rename("Québec", "first-update"), rename("Ottawa", "second-update")], {
          concurrency: "unbounded"
        })
        expect(outcomes.map((outcome) => outcome.revision).sort((left, right) => left - right)).toEqual([2, 3])
        const first = yield* knowledge.revision(1)
        expect(first.entities).toEqual(change.creates)
        const second = yield* knowledge.revision(2)
        const third = yield* knowledge.revision(3)
        expect(second.entities[0]?.values.name).not.toEqual(third.entities[0]?.values.name)
        expect(third.snapshot.schema).toEqual(first.snapshot.schema)
        expect((yield* knowledge.receipts({ inputDeliveryId, limit: 2 })).receipts).toHaveLength(2)
        expect((yield* knowledge.receipts({ inputDeliveryId, afterRevision: 2, limit: 2 })).receipts).toHaveLength(1)
      })
    )
    await opened(
      database.path,
      Effect.gen(function* () {
        const knowledge = yield* PersonalKnowledge
        expect(yield* knowledge.inspect()).toMatchObject({ revision: 3 })
        expect((yield* knowledge.revision(1)).entities).toEqual(change.creates)
        expect((yield* knowledge.revision(3)).entities).toHaveLength(1)
      })
    )
  } finally {
    await database.close()
  }
})

it("migrates the prior empty snapshot and retains it after the first durable write", async () => {
  const database = await temporaryDatabase()
  const legacy = new DatabaseSync(database.path)
  legacy.exec(
    "CREATE TABLE personal_knowledge_snapshot(id INTEGER PRIMARY KEY CHECK(id=1),format INTEGER NOT NULL,payload TEXT NOT NULL)"
  )
  legacy
    .prepare("INSERT INTO personal_knowledge_snapshot(id,format,payload) VALUES(1,1,?)")
    .run(JSON.stringify({ revision: 0, schema: { types: [], relations: [] } }))
  legacy.close()
  try {
    await opened(
      database.path,
      Effect.gen(function* () {
        const knowledge = yield* PersonalKnowledge
        expect(yield* knowledge.inspect()).toEqual({ revision: 0, schema: { types: [], relations: [] } })
        yield* knowledge.apply(change, context)
      })
    )
    await opened(
      database.path,
      Effect.gen(function* () {
        const knowledge = yield* PersonalKnowledge
        expect((yield* knowledge.revision(0)).snapshot).toEqual({ revision: 0, schema: { types: [], relations: [] } })
        expect((yield* knowledge.revision(1)).entities).toEqual(change.creates)
      })
    )
  } finally {
    await database.close()
  }
})
