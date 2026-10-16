import { Effect } from "effect"
import { expect, it } from "vitest"
import { SqliteMemoryStorage, sqliteStorageLayer } from "../src/memory/index.ts"
import {
  PersonalKnowledge,
  sqliteKnowledgeLayer,
  knowledgeLimits,
  type Change,
  type Entity
} from "../src/personal-knowledge/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"

const inputDeliveryId = "11111111-1111-4111-8111-111111111111"
const responseId = "22222222-2222-4222-8222-222222222222"
const context = (operationId: string) => ({ inputDeliveryId, responseId, operationId })
const identity = (index: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${index.toString(16).padStart(12, "0")}`
const entities = (start: number, count: number, size: number): readonly Entity[] =>
  Array.from({ length: count }, (_, offset) => ({
    id: identity(start + offset),
    type: "Entry",
    values: { text: "x".repeat(size) }
  }))
const creation = (creates: readonly Entity[]): Change => ({
  reason: "Retain bounded structured values",
  types: [],
  creates,
  updates: []
})
const declaration: Change = {
  reason: "Declare entries",
  types: [{ name: "Entry", fields: [{ name: "text", kind: "string", required: true }] }],
  creates: [],
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

it("accepts the schema type and field ceilings and rejects larger schemas without publishing a revision", async () => {
  const database = await temporaryDatabase()
  try {
    await opened(
      database.path,
      Effect.gen(function* () {
        const knowledge = yield* PersonalKnowledge
        const types: Change["types"] = Array.from({ length: knowledgeLimits.types }, (_, index) => ({
          name: `Type${index}`,
          fields: Array.from({ length: knowledgeLimits.fieldsPerType }, (_, field) => ({
            name: `field${field}`,
            kind: "string",
            required: false
          }))
        }))
        yield* knowledge.apply(
          { reason: "Declare the finite schema envelope", types, creates: [], updates: [] },
          context("schema")
        )
        expect((yield* knowledge.inspect()).schema.types).toHaveLength(64)
        const excessType = yield* knowledge
          .apply(
            { reason: "One type too many", types: [{ name: "Excess", fields: [] }], creates: [], updates: [] },
            context("excess-type")
          )
          .pipe(Effect.result)
        expect(excessType).toMatchObject({ _tag: "Failure", failure: { code: "LimitExceeded" } })
        const excessFields = yield* knowledge
          .apply(
            {
              reason: "One field too many",
              types: [
                {
                  name: "Wide",
                  fields: Array.from({ length: 33 }, (_, index) => ({
                    name: `field${index}`,
                    kind: "boolean",
                    required: false
                  }))
                }
              ],
              creates: [],
              updates: []
            },
            context("excess-fields")
          )
          .pipe(Effect.result)
        expect(excessFields).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "KnowledgeRejected", code: "LimitExceeded" }
        })
        expect((yield* knowledge.inspect()).revision).toBe(1)
      })
    )
  } finally {
    await database.close()
  }
})

it("retains 100 one-KiB entities across revisions and reopen with explicit complete pagination", async () => {
  const database = await temporaryDatabase()
  try {
    await opened(
      database.path,
      Effect.gen(function* () {
        const knowledge = yield* PersonalKnowledge
        yield* knowledge.apply(declaration, context("declare"))
        yield* knowledge.apply(creation(entities(0, 50, 1024)), context("first-half"))
        yield* knowledge.apply(creation(entities(50, 50, 1024)), context("second-half"))
        const oversized = creation(entities(100, 100, 2048))
        expect(Buffer.byteLength(JSON.stringify(oversized))).toBeGreaterThan(knowledgeLimits.changeBytes)
        expect(yield* knowledge.apply(oversized, context("oversized")).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { code: "LimitExceeded", message: expect.stringContaining("131072") }
        })
        expect((yield* knowledge.inspect()).revision).toBe(3)
      })
    )
    await opened(
      database.path,
      Effect.gen(function* () {
        const knowledge = yield* PersonalKnowledge
        expect((yield* knowledge.revision(2)).entities).toEqual(entities(0, 50, 1024))
        const first = yield* knowledge.query({ type: "Entry", limit: 60 })
        expect(first.entities).toHaveLength(60)
        expect(first.nextAfter).toBe(identity(59))
        const second = yield* knowledge.query({ after: first.nextAfter ?? "", limit: 60 })
        expect(second.nextAfter).toBeNull()
        expect([...first.entities, ...second.entities]).toEqual(entities(0, 100, 1024))
        expect((yield* knowledge.revision(0)).entities).toEqual([])
        const complete = entities(100, 32, 4096)
        const excessBytes = Buffer.byteLength(JSON.stringify(creation(complete))) - knowledgeLimits.changeBytes
        const exact = creation(
          complete.map((entity, index) =>
            index === 31 ? { ...entity, values: { text: "x".repeat(4096 - excessBytes) } } : entity
          )
        )
        expect(Buffer.byteLength(JSON.stringify(exact))).toBe(knowledgeLimits.changeBytes)
        yield* knowledge.apply(exact, context("exact-byte-boundary"))
        const over = { ...exact, reason: `${exact.reason}x` }
        expect(yield* knowledge.apply(over, context("one-byte-over")).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { code: "LimitExceeded" }
        })
        expect((yield* knowledge.inspect()).revision).toBe(4)
      })
    )
  } finally {
    await database.close()
  }
})

it("reports query and four-MiB state byte limits without truncating or advancing the last accepted revision", async () => {
  const database = await temporaryDatabase()
  try {
    await opened(
      database.path,
      Effect.gen(function* () {
        const knowledge = yield* PersonalKnowledge
        yield* knowledge.apply(declaration, context("declare"))
        for (let batch = 0; batch < 3; batch++)
          yield* knowledge.apply(creation(entities(batch * 25, 25, 4096)), context(`batch${batch}`))
        expect(yield* knowledge.query({ limit: 100 }).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { code: "LimitExceeded", message: expect.stringContaining("262144") }
        })
        expect((yield* knowledge.query({ limit: 25 })).entities).toHaveLength(25)
        let accepted = 4
        let stateLimitReached = false
        for (let batch = 3; batch < 45; batch++) {
          const result = yield* knowledge
            .apply(creation(entities(batch * 25, 25, 4096)), context(`batch${batch}`))
            .pipe(Effect.result)
          if (result._tag === "Failure") {
            expect(result.failure).toMatchObject({ code: "LimitExceeded", message: expect.stringContaining("4194304") })
            stateLimitReached = true
            break
          }
          accepted = result.success.revision
        }
        expect(stateLimitReached).toBe(true)
        expect((yield* knowledge.inspect()).revision).toBe(accepted)
        expect((yield* knowledge.revision(2)).entities).toEqual(entities(0, 25, 4096))
        expect(Buffer.byteLength(JSON.stringify(yield* knowledge.revision(accepted)))).toBeLessThanOrEqual(
          knowledgeLimits.stateBytes
        )
      })
    )
  } finally {
    await database.close()
  }
}, 20_000)

it("accepts ten thousand small entities and rejects entity 10001 while retaining accepted history", async () => {
  const database = await temporaryDatabase()
  try {
    await opened(
      database.path,
      Effect.gen(function* () {
        const knowledge = yield* PersonalKnowledge
        yield* knowledge.apply(declaration, context("declare"))
        for (let batch = 0; batch < 100; batch++)
          yield* knowledge.apply(creation(entities(batch * 100, 100, 0)), context(`batch${batch}`))
        expect((yield* knowledge.revision(101)).entities).toHaveLength(10_000)
        expect(
          yield* knowledge.apply(creation(entities(10_000, 1, 0)), context("excess-entity")).pipe(Effect.result)
        ).toMatchObject({ _tag: "Failure", failure: { code: "LimitExceeded" } })
        expect((yield* knowledge.inspect()).revision).toBe(101)
        expect((yield* knowledge.revision(2)).entities).toEqual(entities(0, 100, 0))
      })
    )
  } finally {
    await database.close()
  }
}, 30_000)
