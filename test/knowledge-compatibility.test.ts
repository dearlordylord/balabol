import { createHash } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { Effect, Schema } from "effect"
import { expect, it } from "vitest"
import { SqliteMemoryStorage, sqliteStorageLayer } from "../src/memory/index.ts"
import { Change, PersonalKnowledge, changeIdentity, sqliteKnowledgeLayer } from "../src/personal-knowledge/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"

const oldHash = "e8c08a49715a653548c25c7ecb1c6917d31d3cbb5458accac886de1c0ca2e5db"
const context = {
  inputDeliveryId: "11111111-1111-4111-8111-111111111111",
  responseId: "22222222-2222-4222-8222-222222222222",
  operationId: oldHash
}
const oldChange = {
  reason: "Keep a named place",
  types: [{ name: "Place", fields: [{ name: "name", kind: "string", required: true }] }],
  creates: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", type: "Place", values: { name: "Montréal" } }],
  updates: []
}
const oldReceipt = {
  context,
  revision: 1,
  reason: oldChange.reason,
  createdIds: [oldChange.creates[0]?.id],
  updatedIds: []
}
const initialBytes = JSON.stringify({
  snapshot: { revision: 0, schema: { types: [], relations: [] } },
  entities: [],
  receipt: null
})
const currentBytes = JSON.stringify({
  snapshot: { revision: 1, schema: { types: oldChange.types, relations: [] } },
  entities: oldChange.creates,
  receipt: oldReceipt
})
const outcomeBytes = JSON.stringify({ change: oldChange, receipt: oldReceipt })

it("opens original entity-only format-two history and receipts without changing their bytes or host operation identity", async () => {
  const database = await temporaryDatabase()
  const old = new DatabaseSync(database.path)
  old.exec(
    "CREATE TABLE personal_knowledge_snapshot(id INTEGER PRIMARY KEY CHECK(id=1),format INTEGER NOT NULL,payload TEXT NOT NULL); CREATE TABLE personal_knowledge_revisions(revision INTEGER PRIMARY KEY CHECK(revision>=0),payload TEXT NOT NULL); CREATE TABLE personal_knowledge_receipts(inputDeliveryId TEXT NOT NULL,operationId TEXT NOT NULL,revision INTEGER NOT NULL UNIQUE REFERENCES personal_knowledge_revisions(revision),payload TEXT NOT NULL,receipt TEXT NOT NULL,PRIMARY KEY(inputDeliveryId,operationId))"
  )
  old.prepare("INSERT INTO personal_knowledge_snapshot(id,format,payload) VALUES(1,2,?)").run(currentBytes)
  old
    .prepare("INSERT INTO personal_knowledge_revisions(revision,payload) VALUES(0,?),(1,?)")
    .run(initialBytes, currentBytes)
  old
    .prepare(
      "INSERT INTO personal_knowledge_receipts(inputDeliveryId,operationId,revision,payload,receipt) VALUES(?,?,1,?,?)"
    )
    .run(context.inputDeliveryId, context.operationId, outcomeBytes, JSON.stringify(oldReceipt))
  old.close()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { storage } = yield* SqliteMemoryStorage
          yield* Effect.gen(function* () {
            const knowledge = yield* PersonalKnowledge
            const change = Schema.decodeUnknownSync(Change)(oldChange)
            expect(createHash("sha256").update(changeIdentity(change)).digest("hex")).toBe(oldHash)
            expect((yield* knowledge.inspect()).revision).toBe(1)
            expect((yield* knowledge.revision(0)).relations).toEqual([])
            expect((yield* knowledge.revision(1)).relations).toEqual([])
            const replay = yield* knowledge.apply(change, {
              ...context,
              responseId: "33333333-3333-4333-8333-333333333333"
            })
            expect(replay).toMatchObject(oldReceipt)
            expect(replay.createdRelationIds).toEqual([])
            expect(replay.updatedRelationIds).toEqual([])
            expect(
              (yield* knowledge.receipts({ inputDeliveryId: context.inputDeliveryId, limit: 20 })).receipts
            ).toEqual([replay])
            yield* knowledge.apply(
              Schema.decodeUnknownSync(Change)({
                reason: "Update the retained place",
                types: [],
                creates: [],
                updates: [{ id: oldChange.creates[0]?.id, values: { name: "Québec" } }]
              }),
              { ...context, operationId: "update-place" }
            )
            expect((yield* knowledge.revision(1)).entities).toEqual(oldChange.creates)
            expect((yield* knowledge.revision(2)).entities[0]?.values.name).toBe("Québec")
          }).pipe(Effect.provide(sqliteKnowledgeLayer(storage.database)))
          expect(
            storage.database.prepare("SELECT payload FROM personal_knowledge_revisions WHERE revision=0").get()?.payload
          ).toBe(initialBytes)
          expect(
            storage.database.prepare("SELECT payload FROM personal_knowledge_revisions WHERE revision=1").get()?.payload
          ).toBe(currentBytes)
          expect(
            storage.database.prepare("SELECT payload FROM personal_knowledge_receipts WHERE revision=1").get()?.payload
          ).toBe(outcomeBytes)
        }).pipe(Effect.provide(sqliteStorageLayer(database.path)))
      )
    )
  } finally {
    await database.close()
  }
})
