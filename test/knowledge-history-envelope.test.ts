import { stat } from "node:fs/promises"
import { Effect, Schema } from "effect"
import { expect, it } from "vitest"
import { SqliteMemoryStorage, sqliteStorageLayer } from "../src/memory/index.ts"
import { PersonalKnowledge, sqliteKnowledgeLayer, type Change } from "../src/personal-knowledge/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"

const id = (number: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${number.toString(16).padStart(12, "0")}`
const context = (operationId: string) => ({ inputDeliveryId: id(1000), responseId: id(1001), operationId })
const PayloadTotals = Schema.Struct({ revisions: Schema.Int, snapshotBytes: Schema.Int })

it("measures retained full snapshots for 100 one-KiB entities and twenty accepted updates", async () => {
  const database = await temporaryDatabase()
  try {
    const totals = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { storage } = yield* SqliteMemoryStorage
          yield* Effect.gen(function* () {
            const knowledge = yield* PersonalKnowledge
            yield* knowledge.apply(
              {
                reason: "Declare measured entries",
                types: [{ name: "Entry", fields: [{ name: "text", kind: "string", required: true }] }],
                creates: [],
                updates: []
              },
              context("declare")
            )
            const create: Change = {
              reason: "Create one hundred measured records",
              types: [],
              creates: Array.from({ length: 100 }, (_, index) => ({
                id: id(index),
                type: "Entry",
                values: { text: "x".repeat(1024) }
              })),
              updates: []
            }
            yield* knowledge.apply(create, context("create"))
            for (let revision = 0; revision < 20; revision++) {
              yield* knowledge.apply(
                {
                  reason: "Update one measured value",
                  types: [],
                  creates: [],
                  updates: [
                    { id: id(revision), values: { text: `${revision.toString().padStart(4, "0")}${"x".repeat(1020)}` } }
                  ]
                },
                context(`update-${revision}`)
              )
            }
            expect(
              (yield* knowledge.revision(2)).entities.every((entity) => entity.values.text === "x".repeat(1024))
            ).toBe(true)
            expect((yield* knowledge.revision(22)).entities).toHaveLength(100)
            const first = yield* knowledge.history({ limit: 20 })
            expect(first.revisions.map((revision) => revision.revision)).toEqual(
              Array.from({ length: 20 }, (_, index) => index)
            )
            expect(first.nextAfterRevision).toBe(19)
            const last = yield* knowledge.history({ afterRevision: 19, limit: 20 })
            expect(last.revisions.map((revision) => revision.revision)).toEqual([20, 21, 22])
            expect(last.nextAfterRevision).toBeNull()
          }).pipe(Effect.provide(sqliteKnowledgeLayer(storage.database)))
          const payload = Schema.decodeUnknownSync(PayloadTotals)(
            storage.database
              .prepare(
                "SELECT COUNT(*) AS revisions,SUM(length(CAST(payload AS BLOB))) AS snapshotBytes FROM personal_knowledge_revisions"
              )
              .get()
          )
          const beforeCheckpoint = {
            databaseBytes: (yield* Effect.promise(() => stat(database.path))).size,
            walBytes: (yield* Effect.promise(() => stat(`${database.path}-wal`))).size
          }
          storage.database.exec("PRAGMA wal_checkpoint(TRUNCATE)")
          return {
            ...payload,
            beforeCheckpoint,
            afterCheckpoint: {
              databaseBytes: (yield* Effect.promise(() => stat(database.path))).size,
              walBytes: (yield* Effect.promise(() => stat(`${database.path}-wal`))).size
            }
          }
        }).pipe(Effect.provide(sqliteStorageLayer(database.path)))
      )
    )
    expect(totals.revisions).toBe(23)
    expect(totals.snapshotBytes).toBeGreaterThan(2 * 1024 * 1024)
    expect(totals.afterCheckpoint.databaseBytes).toBeGreaterThan(totals.snapshotBytes)
    expect(totals.afterCheckpoint.walBytes).toBe(0)
    process.stdout.write(`Knowledge history storage envelope: ${JSON.stringify(totals)}\n`)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { storage } = yield* SqliteMemoryStorage
          yield* Effect.gen(function* () {
            const knowledge = yield* PersonalKnowledge
            expect((yield* knowledge.revision(2)).entities[0]?.values.text).toBe("x".repeat(1024))
            expect((yield* knowledge.query({ revision: 22, limit: 100 })).entities).toHaveLength(100)
          }).pipe(Effect.provide(sqliteKnowledgeLayer(storage.database)))
        }).pipe(Effect.provide(sqliteStorageLayer(database.path)))
      )
    )
  } finally {
    await database.close()
  }
})
