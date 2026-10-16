import { Effect, Layer } from "effect"
import { expect, it } from "vitest"
import { SqliteMemoryStorage, sqliteStorageLayer } from "../src/memory/index.ts"
import {
  DurableKnowledge,
  PersonalKnowledge,
  durableKnowledgeLayer,
  personalKnowledgeLayer,
  type Change
} from "../src/personal-knowledge/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"

const context = {
  inputDeliveryId: "11111111-1111-4111-8111-111111111111",
  responseId: "22222222-2222-4222-8222-222222222222",
  operationId: "introduce-place"
}
const change: Change = {
  reason: "Introduce a named place",
  types: [{ name: "Place", fields: [{ name: "name", kind: "string", required: true }] }],
  creates: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", type: "Place", values: { name: "Montréal" } }],
  updates: []
}

it("atomically resolves duplicate commits and rejects conflicting identity or stale revision publication", async () => {
  const database = await temporaryDatabase()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { storage } = yield* SqliteMemoryStorage
          const services = personalKnowledgeLayer.pipe(Layer.provideMerge(durableKnowledgeLayer(storage.database)))
          yield* Effect.gen(function* () {
            const knowledge = yield* PersonalKnowledge
            const durable = yield* DurableKnowledge
            const receipt = yield* knowledge.apply(change, context)
            const revision = yield* knowledge.revision(1)
            const request = { expectedRevision: 0, revision, change }
            expect(yield* durable.commit(request)).toEqual(receipt)
            const conflict = yield* durable
              .commit({ ...request, change: { ...change, reason: "A different accepted intention" } })
              .pipe(Effect.result)
            expect(conflict).toMatchObject({
              _tag: "Failure",
              failure: { _tag: "KnowledgeRejected", code: "IdentityConflict" }
            })
            const stale = yield* durable
              .commit({
                ...request,
                revision: {
                  ...revision,
                  receipt: { ...receipt, context: { ...context, operationId: "stale-publication" } }
                }
              })
              .pipe(Effect.result)
            expect(stale).toMatchObject({
              _tag: "Failure",
              failure: {
                _tag: "KnowledgeRejected",
                code: "IdentityConflict",
                message: expect.stringContaining("revision changed")
              }
            })
            const invalidNext = yield* durable
              .commit({
                ...request,
                expectedRevision: 1,
                revision: {
                  ...revision,
                  receipt: { ...receipt, context: { ...context, operationId: "invalid-next-revision" } }
                }
              })
              .pipe(Effect.result)
            expect(invalidNext).toMatchObject({ _tag: "Failure", failure: { code: "IdentityConflict" } })
            expect(yield* durable.current()).toEqual(revision)
            expect(yield* durable.revision(2)).toBeUndefined()
            expect(yield* knowledge.receipts({ inputDeliveryId: context.inputDeliveryId, limit: 20 })).toEqual({
              receipts: [receipt],
              nextAfterRevision: null
            })
            expect(
              yield* durable.lookup({ inputDeliveryId: context.inputDeliveryId, operationId: "stale-publication" })
            ).toBeUndefined()
          }).pipe(Effect.provide(services))
        }).pipe(Effect.provide(sqliteStorageLayer(database.path)))
      )
    )
  } finally {
    await database.close()
  }
})
