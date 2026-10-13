import { DatabaseSync } from "node:sqlite"
import { Effect } from "effect"
import { expect, it } from "vitest"
import { conversationLayer } from "../src/bootstrap/index.ts"
import { Conversation } from "../src/conversation/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { waitForReply } from "./reply-fixture.ts"

it("upgrades the previous durable schema without losing user identities or positions", async () => {
  const fixture = await temporaryDatabase()
  const id = "11111111-1111-4111-8111-111111111111"
  try {
    const old = new DatabaseSync(fixture.path)
    old.exec(
      "CREATE TABLE records(id INTEGER PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE nodes(level INTEGER NOT NULL,idx INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(level,idx)); CREATE TABLE checkpoint(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL); CREATE TABLE deliveries(deliveryId TEXT PRIMARY KEY,text TEXT NOT NULL,position INTEGER UNIQUE,firstId INTEGER,endExclusive INTEGER)"
    )
    old
      .prepare("INSERT INTO records(id,payload) VALUES(?,?)")
      .run(0, JSON.stringify({ id: 0, kind: "user", text: "old message", date: "2026-10-13T00:00:00.000Z" }))
    old
      .prepare("INSERT INTO deliveries(deliveryId,text,position,firstId,endExclusive) VALUES(?,?,?,?,?)")
      .run(id, "old message", 0, 0, 1)
    old.close()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          expect((yield* conversation.page({ limit: 100 })).messages).toEqual([
            { deliveryId: id, recordId: 0, position: 0, text: "old message", role: "user" }
          ])
          const restarted = yield* conversation.reply(id)
          expect(restarted.error?.code).toBe("Restarted")
          expect(restarted.responseId).not.toBe(id)
          expect((yield* conversation.reply(id)).responseId).toBe(restarted.responseId)
          expect((yield* conversation.send({ deliveryId: id, text: "old message" })).recordId).toBe(0)
          const next = "22222222-2222-4222-8222-222222222222"
          expect((yield* conversation.send({ deliveryId: next, text: "new message" })).position).toBe(1)
          expect((yield* waitForReply(conversation, next)).state).toBe("Completed")
          expect((yield* conversation.page({ limit: 100 })).messages.map((message) => message.position)).toEqual([
            0, 1, 2
          ])
        })
      ).pipe(Effect.provide(conversationLayer(fixture.path)))
    )
  } finally {
    await fixture.close()
  }
})
