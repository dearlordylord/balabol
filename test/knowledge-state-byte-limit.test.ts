import { Effect, Layer, Ref, Schema } from "effect"
import { expect, it } from "vitest"
import {
  DurableKnowledge,
  KnowledgeRevision,
  PersonalKnowledge,
  knowledgeLimits,
  personalKnowledgeLayer,
  type Change
} from "../src/personal-knowledge/index.ts"
import { context, declaration, entities } from "./knowledge-limits-fixture.ts"

const boundaryFixture = () => {
  const size = knowledgeLimits.stringCharacters
  const entityBytes = Buffer.byteLength(JSON.stringify(entities(0, 1, size)[0])) + 1
  const populated = entities(0, Math.ceil(knowledgeLimits.stateBytes / entityBytes), size)
  const last = populated.at(-1)
  if (last === undefined) throw new Error("The byte-boundary fixture needs an entity")
  const receipt = {
    context: context("exact"),
    revision: 43,
    reason: "Update the boundary entry",
    createdIds: [],
    updatedIds: [last.id],
    createdRelationIds: [],
    updatedRelationIds: []
  }
  const full = {
    snapshot: { revision: 43, schema: { types: declaration.types, relations: [] } },
    entities: populated,
    relations: [],
    receipt
  }
  const excess = Buffer.byteLength(JSON.stringify(full)) - knowledgeLimits.stateBytes
  expect(excess).toBeGreaterThanOrEqual(0)
  expect(excess).toBeLessThan(size)
  const text = "x".repeat(size - excess)
  const seed = Schema.decodeUnknownSync(KnowledgeRevision)({
    ...full,
    snapshot: { ...full.snapshot, revision: 42 },
    entities: populated.map((entity) => (entity.id === last.id ? { ...entity, values: { text: "" } } : entity)),
    receipt: { ...receipt, revision: 42, context: context("prior") }
  })
  const change: Change = {
    reason: receipt.reason,
    types: [],
    creates: [],
    updates: [{ id: last.id, values: { text } }]
  }
  return { seed, change, last, text }
}

it("accepts exactly four MiB and rejects one more byte before committing another revision", async () => {
  const { change, last, seed, text } = boundaryFixture()
  await Effect.runPromise(
    Effect.gen(function* () {
      const stored = yield* Ref.make({ revision: seed, commits: 0 })
      const durable = Layer.succeed(DurableKnowledge, {
        current: () => Ref.get(stored).pipe(Effect.map((value) => value.revision)),
        lookup: () => Effect.succeed(undefined),
        revision: (number) => Effect.succeed(number === seed.snapshot.revision ? seed : undefined),
        history: () => Effect.die("Unexpected boundary-test history request"),
        receiptsByInput: () => Effect.die("Unexpected boundary-test receipt request"),
        commit: (request) =>
          Effect.gen(function* () {
            const receipt = request.revision.receipt
            if (receipt === null) return yield* Effect.die("A committed revision needs its receipt")
            yield* Ref.update(stored, (value) => ({ revision: request.revision, commits: value.commits + 1 }))
            return receipt
          })
      })
      yield* Effect.gen(function* () {
        const knowledge = yield* PersonalKnowledge
        expect((yield* knowledge.apply(change, context("exact"))).revision).toBe(43)
        expect(Buffer.byteLength(JSON.stringify((yield* Ref.get(stored)).revision))).toBe(knowledgeLimits.stateBytes)
        const over = { ...change, updates: [{ id: last.id, values: { text: `${text}x` } }] }
        expect(yield* knowledge.apply(over, context("extra")).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { code: "LimitExceeded", message: expect.stringContaining("4194304") }
        })
        expect((yield* knowledge.inspect()).revision).toBe(43)
        expect((yield* Ref.get(stored)).commits).toBe(1)
        expect(yield* knowledge.revision(42)).toEqual(seed)
      }).pipe(Effect.provide(personalKnowledgeLayer.pipe(Layer.provide(durable))))
    })
  )
})
