import { DatabaseSync } from "node:sqlite"
import { Effect, Schema } from "effect"
import { expect, it } from "vitest"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { Conversation } from "../src/conversation/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { replyLayer } from "./reply-fixture.ts"

const first = "abcdefab-cdef-4abc-8def-abcdefabcdef"
const second = "fedcbafe-dcba-4fed-8cba-fedcbafedcba"
it("canonicalizes legacy UUIDs while preserving positions, raw journal and pending interruption evidence across restart", async () => {
  const fixture = await temporaryDatabase()
  try {
    const oldResponse = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          yield* conversation.send({ deliveryId: first, text: "Case Preserved" })
          const reply = yield* conversation.reply(first)
          yield* conversation.cancelReply(first)
          return reply.responseId
        })
      ).pipe(Effect.provide(replyLayer(fixture.path, fakeAnswerLayer(1000))))
    )
    const legacy = new DatabaseSync(fixture.path)
    const journal = legacy.prepare("SELECT payload FROM records ORDER BY id").all()
    legacy.exec(
      "UPDATE deliveries SET deliveryId=upper(deliveryId),inputDeliveryId=upper(inputDeliveryId),responseId=upper(responseId)"
    )
    legacy
      .prepare("INSERT INTO deliveries(deliveryId,text,role,inputDeliveryId,responseId,outcome) VALUES(?,?,?,?,?,?)")
      .run(
        oldResponse.toUpperCase(),
        "Legacy Partial",
        "assistant",
        first.toUpperCase(),
        oldResponse.toUpperCase(),
        "interrupted"
      )
    legacy.close()
    const restored = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          const accepted = yield* conversation.send({ deliveryId: first.toUpperCase(), text: "Case Preserved" })
          expect(accepted).toMatchObject({ deliveryId: first, position: 0, recordId: 0, text: "Case Preserved" })
          expect((yield* conversation.reply(first.toUpperCase())).responseId).toBe(oldResponse)
          yield* conversation.send({ deliveryId: second.toUpperCase(), text: "next" })
          const reply = yield* conversation.reply(first)
          expect(reply.state).toBe("Interrupted")
          expect(reply.text).toBe("Legacy Partial")
          expect(reply.responseId).toBe(oldResponse)
          expect((yield* conversation.page({ limit: 100 })).messages.map((message) => message.position)).toEqual([
            0, 1, 2
          ])
          yield* conversation.cancelReply(second)
          return reply
        })
      ).pipe(Effect.provide(replyLayer(fixture.path, fakeAnswerLayer(1000))))
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          expect(yield* conversation.reply(first.toUpperCase())).toEqual(restored)
          expect((yield* conversation.send({ deliveryId: second, text: "next" })).position).toBe(2)
        })
      ).pipe(Effect.provide(replyLayer(fixture.path, fakeAnswerLayer(1000))))
    )
    const reopened = new DatabaseSync(fixture.path)
    expect(reopened.prepare("SELECT payload FROM records ORDER BY id LIMIT 1").all()).toEqual(journal)
    reopened.close()
  } finally {
    await fixture.close()
  }
})
for (const collision of ["delivery", "reply"] as const)
  it(`fails honestly without merging a legacy logical ${collision} UUID collision`, async () => {
    const fixture = await temporaryDatabase()
    try {
      const old = new DatabaseSync(fixture.path)
      old.exec(
        "CREATE TABLE deliveries(deliveryId TEXT PRIMARY KEY,text TEXT NOT NULL,position INTEGER UNIQUE,firstId INTEGER,endExclusive INTEGER,role TEXT NOT NULL DEFAULT 'user',inputDeliveryId TEXT,responseId TEXT,outcome TEXT)"
      )
      const insert = old.prepare(
        "INSERT INTO deliveries(deliveryId,text,position,firstId,endExclusive,role,inputDeliveryId,responseId,outcome) VALUES(?,?,?,?,?,?,?,?,?)"
      )
      if (collision === "delivery") {
        insert.run(first, "one", 0, 0, 1, "user", null, null, null)
        insert.run(first.toUpperCase(), "two", 1, 1, 2, "user", null, null, null)
      } else {
        insert.run(second, "one", 0, 0, 1, "assistant", first, second, "completed")
        const third = "11111111-2222-4333-8444-555555555555"
        insert.run(third, "two", 1, 1, 2, "assistant", first.toUpperCase(), third, "completed")
      }
      const original = old.prepare("SELECT * FROM deliveries ORDER BY position").all()
      old.close()
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            return yield* Conversation
          })
        ).pipe(Effect.provide(replyLayer(fixture.path, fakeAnswerLayer(1000))), Effect.result)
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure._tag).toBe("WriterUnavailable")
      const unchanged = new DatabaseSync(fixture.path)
      expect(
        Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(
          unchanged.prepare("SELECT * FROM deliveries ORDER BY position").all()
        )
      ).toEqual(original)
      unchanged.close()
    } finally {
      await fixture.close()
    }
  })
