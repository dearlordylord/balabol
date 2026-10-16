import { fork } from "node:child_process"
import { once } from "node:events"
import { fileURLToPath } from "node:url"
import { Effect, Layer, Schema } from "effect"
import { expect, it } from "vitest"
import { SqliteMemoryStorage, sqliteStorageLayer } from "../src/memory/index.ts"
import { Change, HostContext, PersonalKnowledge, sqliteKnowledgeLayer } from "../src/personal-knowledge/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"

it("recovers committed knowledge and its original receipt after SIGKILL before acknowledgement", async () => {
  const fixture = await temporaryDatabase()
  const entity = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    type: "Place",
    values: { name: "Montréal", visited: true }
  }
  const change = Schema.decodeUnknownSync(Change)({
    reason: "Retain the chosen place",
    types: [
      {
        name: "Place",
        fields: [
          { name: "name", kind: "string", required: true },
          { name: "visited", kind: "boolean", required: false }
        ]
      }
    ],
    creates: [entity],
    updates: []
  })
  const context = Schema.decodeUnknownSync(HostContext)({
    inputDeliveryId: "11111111-1111-4111-8111-111111111111",
    responseId: "22222222-2222-4222-8222-222222222222",
    operationId: "save-place"
  })
  const child = fork(
    fileURLToPath(new URL("./knowledge-crash-child.ts", import.meta.url)),
    [fixture.path, JSON.stringify({ change, context })],
    { execArgv: ["--experimental-strip-types"], stdio: ["ignore", "ignore", "pipe", "ipc"] }
  )
  try {
    const [message] = await Promise.race([
      once(child, "message"),
      once(child, "exit").then(([code]) => {
        throw new Error(`Knowledge child exited before commit: ${String(code)}`)
      })
    ])
    expect(message).toBe("knowledge-committed")
    const exited = once(child, "exit")
    child.kill("SIGKILL")
    await exited
    const reopened = Layer.unwrap(
      Effect.gen(function* () {
        const { storage } = yield* SqliteMemoryStorage
        return sqliteKnowledgeLayer(storage.database)
      })
    ).pipe(Layer.provide(sqliteStorageLayer(fixture.path)))
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const knowledge = yield* PersonalKnowledge
          const expectedReceipt = {
            context,
            revision: 1,
            reason: change.reason,
            createdIds: [entity.id],
            updatedIds: []
          }
          expect((yield* knowledge.receipts({ inputDeliveryId: context.inputDeliveryId, limit: 20 })).receipts).toEqual(
            [expectedReceipt]
          )
          expect(yield* knowledge.query({ limit: 100 })).toEqual({
            revision: 1,
            schema: { types: change.types, relations: [] },
            entities: [entity],
            nextAfter: null
          })
          expect(yield* knowledge.revision(0)).toEqual({
            snapshot: { revision: 0, schema: { types: [], relations: [] } },
            entities: [],
            receipt: null
          })
          expect(yield* knowledge.revision(1)).toEqual({
            snapshot: { revision: 1, schema: { types: change.types, relations: [] } },
            entities: [entity],
            receipt: expectedReceipt
          })
          expect(
            yield* knowledge.apply(change, { ...context, responseId: "33333333-3333-4333-8333-333333333333" })
          ).toEqual(expectedReceipt)
          expect((yield* knowledge.inspect()).revision).toBe(1)
          const nonexistent = yield* Effect.result(knowledge.revision(2))
          expect(nonexistent._tag).toBe("Failure")
          if (nonexistent._tag === "Failure")
            expect(nonexistent.failure).toMatchObject({ _tag: "KnowledgeRejected", code: "RevisionNotFound" })
        }).pipe(Effect.provide(reopened))
      )
    )
  } finally {
    child.kill("SIGKILL")
    await fixture.close()
  }
})

it("rolls back partial knowledge transaction after SIGKILL before commit and permits a fresh change", async () => {
  const fixture = await temporaryDatabase()
  const entity = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", type: "Counter", values: { count: 3 } }
  const change = Schema.decodeUnknownSync(Change)({
    reason: "Save a numeric counter",
    types: [{ name: "Counter", fields: [{ name: "count", kind: "number", required: true }] }],
    creates: [entity],
    updates: []
  })
  const context = Schema.decodeUnknownSync(HostContext)({
    inputDeliveryId: "44444444-4444-4444-8444-444444444444",
    responseId: "55555555-5555-4555-8555-555555555555",
    operationId: "save-counter"
  })
  const child = fork(
    fileURLToPath(new URL("./knowledge-crash-child.ts", import.meta.url)),
    [fixture.path, JSON.stringify({ change, context }), "before-commit"],
    { execArgv: ["--experimental-strip-types"], stdio: ["ignore", "pipe", "pipe", "ipc"] }
  )
  try {
    if (child.stdout === null) throw new Error("Missing child transaction signal")
    const [marker] = await Promise.race([
      once(child.stdout, "data"),
      once(child, "exit").then(([code]) => {
        throw new Error(`Knowledge child exited before partial transaction: ${String(code)}`)
      })
    ])
    expect(String(marker)).toBe("knowledge-partial\n")
    const exited = once(child, "exit")
    child.kill("SIGKILL")
    await exited
    const reopened = Layer.unwrap(
      Effect.gen(function* () {
        const { storage } = yield* SqliteMemoryStorage
        return sqliteKnowledgeLayer(storage.database)
      })
    ).pipe(Layer.provide(sqliteStorageLayer(fixture.path)))
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const knowledge = yield* PersonalKnowledge
          expect(yield* knowledge.query({ limit: 100 })).toEqual({
            revision: 0,
            schema: { types: [], relations: [] },
            entities: [],
            nextAfter: null
          })
          expect(yield* knowledge.revision(0)).toEqual({
            snapshot: { revision: 0, schema: { types: [], relations: [] } },
            entities: [],
            receipt: null
          })
          expect(yield* knowledge.receipts({ inputDeliveryId: context.inputDeliveryId, limit: 20 })).toEqual({
            receipts: [],
            nextAfterRevision: null
          })
          const missing = yield* Effect.result(knowledge.revision(1))
          expect(missing._tag).toBe("Failure")
          if (missing._tag === "Failure")
            expect(missing.failure).toMatchObject({ _tag: "KnowledgeRejected", code: "RevisionNotFound" })
          expect((yield* knowledge.apply(change, context)).revision).toBe(1)
          expect((yield* knowledge.query({ limit: 100 })).entities).toEqual([entity])
          expect((yield* knowledge.revision(1)).snapshot.schema.types).toEqual(change.types)
        }).pipe(Effect.provide(reopened))
      )
    )
  } finally {
    child.kill("SIGKILL")
    await fixture.close()
  }
})
