import { Effect, Schema } from "effect"
import { expect, it } from "vitest"
import { SqliteMemoryStorage, sqliteStorageLayer } from "../src/memory/index.ts"
import { Change, PersonalKnowledge, sqliteKnowledgeLayer } from "../src/personal-knowledge/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"

const id = (number: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${number.toString(16).padStart(12, "0")}`
const context = { inputDeliveryId: id(100), responseId: id(101), operationId: "association-graph" }
const fixture = {
  reason: "Keep distinct meanings and explicit associations",
  types: [
    {
      name: "Expression",
      fields: [
        { name: "text", kind: "string", required: true },
        { name: "language", kind: "string", required: true }
      ]
    },
    { name: "Place", fields: [{ name: "name", kind: "string", required: true }] }
  ],
  creates: [
    { id: id(1), type: "Expression", values: { text: "pain", language: "fr" } },
    { id: id(2), type: "Expression", values: { text: "pain", language: "en" } },
    { id: id(3), type: "Expression", values: { text: "bread", language: "en" } },
    { id: id(4), type: "Place", values: { name: "bakery" } }
  ],
  updates: [],
  relationTypes: [
    {
      name: "Mnemonic",
      sources: ["Expression", "Place"],
      targets: ["Expression", "Place"],
      fields: [{ name: "cue", kind: "string", required: true }]
    },
    { name: "Translation", sources: ["Expression"], targets: ["Expression"], fields: [] }
  ],
  relationCreates: [
    {
      id: id(11),
      type: "Mnemonic",
      source: id(1),
      target: id(2),
      values: { cue: "same spelling, different meanings" }
    },
    { id: id(12), type: "Translation", source: id(2), target: id(3), values: {} },
    { id: id(13), type: "Mnemonic", source: id(3), target: id(1), values: { cue: "remember French bread" } },
    { id: id(14), type: "Mnemonic", source: id(4), target: id(1), values: { cue: "bakery visit" } },
    { id: id(15), type: "Mnemonic", source: id(3), target: id(4), values: { cue: "place association" } }
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

it("bounds cyclic neighborhoods by depth, direction and relation type and paginates stable relation identities", async () => {
  const database = await temporaryDatabase()
  try {
    await opened(
      database.path,
      Effect.gen(function* () {
        const knowledge = yield* PersonalKnowledge
        yield* knowledge.apply(Schema.decodeUnknownSync(Change)(fixture), context)
        const outgoing = yield* knowledge.neighborhood({ id: id(1), depth: 1, direction: "outgoing", limit: 100 })
        expect(outgoing.relations.map((relation) => relation.id)).toEqual([id(11)])
        expect(outgoing.entities.map((entity) => entity.id)).toEqual([id(1), id(2)])
        expect(outgoing.root.id).toBe(id(1))
        expect(outgoing.revision).toBe(1)
        expect(outgoing.schema.relations).toHaveLength(2)
        const incoming = yield* knowledge.neighborhood({ id: id(1), depth: 1, direction: "incoming", limit: 100 })
        expect(incoming.relations.map((relation) => relation.id)).toEqual([id(13), id(14)])
        const deeper = yield* knowledge.neighborhood({ id: id(1), depth: 2, direction: "outgoing", limit: 100 })
        expect(deeper.relations.map((relation) => relation.id)).toEqual([id(11), id(12)])
        const filtered = yield* knowledge.neighborhood({
          id: id(1),
          depth: 2,
          direction: "outgoing",
          relationTypes: ["Mnemonic"],
          limit: 100
        })
        expect(filtered.relations.map((relation) => relation.id)).toEqual([id(11)])
        const first = yield* knowledge.neighborhood({ id: id(1), depth: 2, direction: "both", limit: 2 })
        expect(first.relations.map((relation) => relation.id)).toEqual([id(11), id(12)])
        expect(first.truncated).toBe(true)
        expect(first.nextAfter).toBe(id(12))
        const second = yield* knowledge.neighborhood({
          id: id(1),
          depth: 2,
          direction: "both",
          after: id(12),
          limit: 2
        })
        const last = yield* knowledge.neighborhood({ id: id(1), depth: 2, direction: "both", after: id(14), limit: 2 })
        expect([...first.relations, ...second.relations, ...last.relations].map((relation) => relation.id)).toEqual([
          id(11),
          id(12),
          id(13),
          id(14),
          id(15)
        ])
        expect(last.truncated).toBe(false)
        expect(last.nextAfter).toBeNull()
      })
    )
  } finally {
    await database.close()
  }
})

it("validates typed equality filters and neighborhood roots and retains association metadata through update and reopen", async () => {
  const database = await temporaryDatabase()
  try {
    await opened(
      database.path,
      Effect.gen(function* () {
        const knowledge = yield* PersonalKnowledge
        const receipt = yield* knowledge.apply(Schema.decodeUnknownSync(Change)(fixture), context)
        expect(
          yield* knowledge.apply(Schema.decodeUnknownSync(Change)(fixture), { ...context, responseId: id(102) })
        ).toEqual(receipt)
        expect(
          (yield* knowledge.query({ type: "Expression", where: { text: "pain" }, limit: 100 })).entities.map(
            (entity) => entity.id
          )
        ).toEqual([id(1), id(2)])
        expect(
          (yield* knowledge.query({ type: "Expression", where: { language: "fr" }, limit: 100 })).entities.map(
            (entity) => entity.id
          )
        ).toEqual([id(1)])
        for (const query of [
          { where: { text: "pain" }, limit: 10 },
          { type: "Missing", where: { text: "pain" }, limit: 10 },
          { type: "Expression", where: { unknown: "pain" }, limit: 10 },
          { type: "Expression", where: { text: true }, limit: 10 }
        ]) {
          expect(yield* knowledge.query(query).pipe(Effect.result)).toMatchObject({
            _tag: "Failure",
            failure: { _tag: "KnowledgeRejected" }
          })
        }
        expect(
          yield* knowledge.neighborhood({ id: id(999), depth: 1, direction: "both", limit: 10 }).pipe(Effect.result)
        ).toMatchObject({ _tag: "Failure", failure: { code: "InvalidEntity" } })
        expect(
          yield* knowledge
            .neighborhood({ id: id(1), depth: 1, direction: "both", relationTypes: ["Missing"], limit: 10 })
            .pipe(Effect.result)
        ).toMatchObject({ _tag: "Failure", failure: { _tag: "KnowledgeRejected" } })
        yield* knowledge.apply(
          Schema.decodeUnknownSync(Change)({
            reason: "Refine a mnemonic",
            types: [],
            creates: [],
            updates: [],
            relationUpdates: [{ id: id(15), source: id(3), target: id(4), values: { cue: "the familiar bakery" } }]
          }),
          { ...context, operationId: "refine-mnemonic" }
        )
        expect((yield* knowledge.revision(1)).relations.find((relation) => relation.id === id(15))?.values.cue).toBe(
          "place association"
        )
        expect((yield* knowledge.inspect()).revision).toBe(2)
      })
    )
    await opened(
      database.path,
      Effect.gen(function* () {
        const knowledge = yield* PersonalKnowledge
        const page = yield* knowledge.neighborhood({ id: id(4), depth: 1, direction: "incoming", limit: 100 })
        expect(page.relations).toEqual([
          { id: id(15), type: "Mnemonic", source: id(3), target: id(4), values: { cue: "the familiar bakery" } }
        ])
        expect((yield* knowledge.revision(1)).relations).toEqual(fixture.relationCreates)
        expect(
          (yield* knowledge.receipts({ inputDeliveryId: context.inputDeliveryId, limit: 20 })).receipts
        ).toHaveLength(2)
      })
    )
  } finally {
    await database.close()
  }
})

it("rejects oversized association responses and identity collisions while allowing a smaller complete page", async () => {
  const database = await temporaryDatabase()
  try {
    await opened(
      database.path,
      Effect.gen(function* () {
        const knowledge = yield* PersonalKnowledge
        yield* knowledge.apply(Schema.decodeUnknownSync(Change)({ ...fixture, relationCreates: [] }), context)
        for (let batch = 0; batch < 4; batch++) {
          yield* knowledge.apply(
            Schema.decodeUnknownSync(Change)({
              reason: "Retain explicit association metadata",
              types: [],
              creates: [],
              updates: [],
              relationCreates: Array.from({ length: 25 }, (_, offset) => ({
                id: id(1000 + batch * 25 + offset),
                type: "Mnemonic",
                source: id(1),
                target: id(2),
                values: { cue: "x".repeat(4096) }
              }))
            }),
            { ...context, operationId: `association-batch-${batch}` }
          )
        }
        expect(
          yield* knowledge.neighborhood({ id: id(1), depth: 1, direction: "outgoing", limit: 100 }).pipe(Effect.result)
        ).toMatchObject({
          _tag: "Failure",
          failure: { code: "LimitExceeded", message: expect.stringContaining("262144") }
        })
        const first = yield* knowledge.neighborhood({ id: id(1), depth: 1, direction: "outgoing", limit: 25 })
        expect(first.relations).toHaveLength(25)
        expect(first.entities.map((entity) => entity.id)).toEqual([id(1), id(2)])
        expect(first.truncated).toBe(true)
        expect(first.nextAfter).toBe(id(1024))
        const relationCollision = Schema.decodeUnknownSync(Change)({
          reason: "A relation cannot reuse an entity identity",
          types: [],
          creates: [],
          updates: [],
          relationCreates: [{ id: id(1), type: "Mnemonic", source: id(1), target: id(2), values: { cue: "collision" } }]
        })
        expect(
          yield* knowledge
            .apply(relationCollision, { ...context, operationId: "relation-collision" })
            .pipe(Effect.result)
        ).toMatchObject({ _tag: "Failure", failure: { code: "IdentityConflict" } })
        const entityCollision = Schema.decodeUnknownSync(Change)({
          reason: "An entity cannot reuse a relation identity",
          types: [],
          creates: [{ id: id(1000), type: "Place", values: { name: "collision" } }],
          updates: []
        })
        expect(
          yield* knowledge.apply(entityCollision, { ...context, operationId: "entity-collision" }).pipe(Effect.result)
        ).toMatchObject({ _tag: "Failure", failure: { code: "IdentityConflict" } })
        expect((yield* knowledge.inspect()).revision).toBe(5)
        expect((yield* knowledge.revision(5)).relations).toHaveLength(100)
      })
    )
  } finally {
    await database.close()
  }
})
