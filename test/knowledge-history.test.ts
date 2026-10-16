import { Effect, Schema } from "effect"
import { expect, it } from "vitest"
import { SqliteMemoryStorage, sqliteStorageLayer } from "../src/memory/index.ts"
import { Change, PersonalKnowledge, sqliteKnowledgeLayer } from "../src/personal-knowledge/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"

const id = (number: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${number.toString(16).padStart(12, "0")}`
const context = (operationId: string) => ({ inputDeliveryId: id(100), responseId: id(101), operationId })
const initial = {
  reason: "Keep explicit places and associations",
  types: [{ name: "Place", fields: [{ name: "text", kind: "string", required: true }] }],
  creates: [
    { id: id(1), type: "Place", values: { text: "Montréal" } },
    { id: id(2), type: "Place", values: { text: "Québec" } }
  ],
  updates: [],
  relationTypes: [
    {
      name: "Journey",
      sources: ["Place"],
      targets: ["Place"],
      fields: [{ name: "cue", kind: "string", required: true }]
    }
  ],
  relationCreates: [{ id: id(3), type: "Journey", source: id(1), target: id(2), values: { cue: "train" } }]
}
const migration = {
  reason: "Clarify labels while preserving places and journeys",
  types: [],
  creates: [],
  updates: [],
  migrations: [
    { kind: "RenameField", target: "entity", type: "Place", from: "text", to: "label" },
    { kind: "RenameField", target: "relation", type: "Journey", from: "cue", to: "hint" },
    {
      kind: "AddField",
      target: "relation",
      type: "Journey",
      field: { name: "familiar", kind: "boolean", required: true },
      default: true
    }
  ]
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

it("lists accepted history with inclusive revision bounds and reconstructs original entity and relation schemas after reopen", async () => {
  const database = await temporaryDatabase()
  try {
    await opened(
      database.path,
      Effect.gen(function* () {
        const knowledge = yield* PersonalKnowledge
        yield* knowledge.apply(Schema.decodeUnknownSync(Change)(initial), context("create"))
        yield* knowledge.apply(Schema.decodeUnknownSync(Change)(migration), context("migrate"))
        yield* knowledge.apply(
          Schema.decodeUnknownSync(Change)({
            reason: "Reverse the journey",
            types: [],
            creates: [],
            updates: [],
            relationUpdates: [
              { id: id(3), source: id(2), target: id(1), values: { hint: "return train", familiar: true } }
            ]
          }),
          context("reverse")
        )
      })
    )
    await opened(
      database.path,
      Effect.gen(function* () {
        const knowledge = yield* PersonalKnowledge
        const first = yield* knowledge.history({ limit: 2 })
        expect(first).toEqual({
          revisions: [
            { revision: 0, reason: null, context: null },
            { revision: 1, reason: initial.reason, context: context("create") }
          ],
          nextAfterRevision: 1
        })
        expect(yield* knowledge.history({ afterRevision: 1, throughRevision: 2, limit: 2 })).toEqual({
          revisions: [{ revision: 2, reason: migration.reason, context: context("migrate") }],
          nextAfterRevision: null
        })
        expect((yield* knowledge.history({ afterRevision: 3, limit: 2 })).revisions).toEqual([])
        expect(
          (yield* knowledge.query({ revision: 1, type: "Place", where: { text: "Montréal" }, limit: 10 })).entities
        ).toEqual([initial.creates[0]])
        expect(
          (yield* knowledge.query({ revision: 2, type: "Place", where: { label: "Montréal" }, limit: 10 })).entities
        ).toEqual([{ id: id(1), type: "Place", values: { label: "Montréal" } }])
        const old = yield* knowledge.neighborhood({
          revision: 1,
          id: id(1),
          depth: 1,
          direction: "outgoing",
          limit: 10
        })
        expect(old.schema.relations).toEqual(initial.relationTypes)
        expect(old.relations).toEqual(initial.relationCreates)
        const current = yield* knowledge.neighborhood({ id: id(2), depth: 1, direction: "outgoing", limit: 10 })
        expect(current.relations).toEqual([
          { id: id(3), type: "Journey", source: id(2), target: id(1), values: { hint: "return train", familiar: true } }
        ])
        expect((yield* knowledge.revision(1)).snapshot.schema.types).toEqual(initial.types)
        expect((yield* knowledge.revision(2)).receipt?.reason).toBe(migration.reason)
        expect((yield* knowledge.difference({ fromRevision: 2, toRevision: 3, limit: 10 })).changes).toEqual([
          {
            kind: "Relation",
            id: id(3),
            type: "Journey",
            change: "updated",
            changedFields: ["hint"],
            endpointsChanged: true
          }
        ])
        expect(
          yield* knowledge.history({ afterRevision: 2, throughRevision: 1, limit: 2 }).pipe(Effect.result)
        ).toMatchObject({ _tag: "Failure", failure: { _tag: "KnowledgeRejected" } })
      })
    )
  } finally {
    await database.close()
  }
})

it("pages structural differences by schema phases and affected identities and reports endpoint changes", async () => {
  const database = await temporaryDatabase()
  try {
    await opened(
      database.path,
      Effect.gen(function* () {
        const knowledge = yield* PersonalKnowledge
        yield* knowledge.apply(Schema.decodeUnknownSync(Change)(initial), context("create"))
        yield* knowledge.apply(Schema.decodeUnknownSync(Change)(migration), context("migrate"))
        const first = yield* knowledge.difference({ fromRevision: 1, toRevision: 2, limit: 2 })
        expect(first.from).toEqual({ revision: 1, reason: initial.reason, context: context("create") })
        expect(first.to).toEqual({ revision: 2, reason: migration.reason, context: context("migrate") })
        expect(first.changes).toMatchObject([
          {
            kind: "EntityType",
            name: "Place",
            before: initial.types[0],
            after: { name: "Place", fields: [{ name: "label", kind: "string", required: true }] }
          },
          { kind: "RelationType", name: "Journey", before: initial.relationTypes[0] }
        ])
        const second = yield* knowledge.difference({
          fromRevision: 1,
          toRevision: 2,
          after: first.nextAfter ?? "",
          limit: 2
        })
        expect(second.changes).toEqual(
          [1, 2].map((number) => ({
            kind: "Entity",
            id: id(number),
            type: "Place",
            change: "updated",
            changedFields: ["label", "text"]
          }))
        )
        const last = yield* knowledge.difference({
          fromRevision: 1,
          toRevision: 2,
          after: second.nextAfter ?? "",
          limit: 2
        })
        expect(last.changes).toEqual([
          {
            kind: "Relation",
            id: id(3),
            type: "Journey",
            change: "updated",
            changedFields: ["cue", "familiar", "hint"],
            endpointsChanged: false
          }
        ])
        expect(last.nextAfter).toBeNull()
        const created = yield* knowledge.difference({ fromRevision: 0, toRevision: 1, limit: 10 })
        expect(created.changes).toContainEqual({
          kind: "Relation",
          id: id(3),
          type: "Journey",
          change: "created",
          changedFields: ["cue"],
          endpointsChanged: true
        })
        const removed = yield* knowledge.difference({ fromRevision: 1, toRevision: 0, limit: 10 })
        expect(removed.changes).toContainEqual({
          kind: "Entity",
          id: id(1),
          type: "Place",
          change: "deleted",
          changedFields: ["text"]
        })
        expect(removed.changes).toContainEqual({
          kind: "Relation",
          id: id(3),
          type: "Journey",
          change: "deleted",
          changedFields: ["cue"],
          endpointsChanged: true
        })
        expect((yield* knowledge.difference({ fromRevision: 2, toRevision: 2, limit: 10 })).changes).toEqual([])
        expect(
          yield* knowledge
            .difference({ fromRevision: 1, toRevision: 2, after: "invalid-cursor", limit: 10 })
            .pipe(Effect.result)
        ).toMatchObject({ _tag: "Failure", failure: { _tag: "KnowledgeRejected" } })
        expect(
          yield* knowledge.difference({ fromRevision: 1, toRevision: 99, limit: 10 }).pipe(Effect.result)
        ).toMatchObject({ _tag: "Failure", failure: { code: "RevisionNotFound" } })
        expect(yield* knowledge.query({ revision: 99, limit: 10 }).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { code: "RevisionNotFound" }
        })
      })
    )
  } finally {
    await database.close()
  }
})

it("reports unavailable history when an accepted revision has lost its durable operation metadata", async () => {
  const database = await temporaryDatabase()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { storage } = yield* SqliteMemoryStorage
          yield* Effect.gen(function* () {
            const knowledge = yield* PersonalKnowledge
            yield* knowledge.apply(Schema.decodeUnknownSync(Change)(initial), context("create"))
            storage.database.prepare("DELETE FROM personal_knowledge_receipts WHERE revision=1").run()
            expect(yield* knowledge.history({ limit: 20 }).pipe(Effect.result)).toMatchObject({
              _tag: "Failure",
              failure: { _tag: "KnowledgeUnavailable" }
            })
            expect((yield* knowledge.revision(1)).entities).toEqual(initial.creates)
          }).pipe(Effect.provide(sqliteKnowledgeLayer(storage.database)))
        }).pipe(Effect.provide(sqliteStorageLayer(database.path)))
      )
    )
  } finally {
    await database.close()
  }
})

it("continues difference pages for maximum-length names that expand when encoded in a cursor", async () => {
  const database = await temporaryDatabase()
  const escapedName = "\u0000".repeat(128)
  try {
    await opened(
      database.path,
      Effect.gen(function* () {
        const knowledge = yield* PersonalKnowledge
        yield* knowledge.apply(
          {
            reason: "Retain valid names with JSON escaping",
            types: [
              { name: escapedName, fields: [] },
              { name: "Another", fields: [] }
            ],
            creates: [],
            updates: []
          },
          context("escaped-name")
        )
        const first = yield* knowledge.difference({ fromRevision: 0, toRevision: 1, limit: 1 })
        expect(first.changes).toMatchObject([{ kind: "EntityType", name: escapedName }])
        expect(first.nextAfter?.length).toBeGreaterThan(512)
        const last = yield* knowledge.difference({
          fromRevision: 0,
          toRevision: 1,
          after: first.nextAfter ?? "",
          limit: 1
        })
        expect(last.changes).toMatchObject([{ kind: "EntityType", name: "Another" }])
        expect(last.nextAfter).toBeNull()
        expect([...first.changes, ...last.changes]).toHaveLength(2)
      })
    )
  } finally {
    await database.close()
  }
})
