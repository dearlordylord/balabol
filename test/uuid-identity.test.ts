import { it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vitest"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { Conversation } from "../src/conversation/index.ts"
import { DeliveryPayload, Memory, memoryLayer } from "../src/memory/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { replyLayer } from "./reply-fixture.ts"

const id = "abcdefab-cdef-4abc-8def-abcdefabcdef"
const second = "fedcbafe-dcba-4fed-8cba-fedcbafedcba"
it.effect("treats mixed-case delivery and observer UUIDs as the same identity without interrupting a newer reply", () =>
  Effect.gen(function* () {
    const fixture = yield* Effect.promise(temporaryDatabase)
    yield* Effect.gen(function* () {
      const conversation = yield* Conversation
      const accepted = yield* conversation.send({ deliveryId: id.toUpperCase(), text: "Preserve Case" })
      expect(accepted.deliveryId).toBe(id)
      const token = yield* conversation.observeReply(id.toUpperCase())
      yield* TestClock.adjust(10)
      expect((yield* conversation.reply(id)).inputDeliveryId).toBe(id)
      yield* conversation.releaseReply(id, token)
      expect((yield* conversation.reply(id.toUpperCase())).state).toBe("Failed")
      yield* conversation.send({ deliveryId: second, text: "newer" })
      const before = yield* conversation.reply(second)
      const replay = yield* conversation.send({ deliveryId: id, text: "Preserve Case" })
      expect(replay).toEqual(accepted)
      expect((yield* conversation.reply(second)).responseId).toBe(before.responseId)
      expect((yield* conversation.reply(second)).state).not.toBe("Interrupted")
      yield* conversation.cancelReply(second.toUpperCase())
      expect((yield* conversation.reply(second)).state).toBe("Failed")
      expect(
        (yield* Effect.flip(conversation.send({ deliveryId: id.toUpperCase(), text: "preserve case" })))._tag
      ).toBe("DeliveryConflict")
      expect((yield* conversation.page({ limit: 100 })).messages).toHaveLength(2)
    }).pipe(
      Effect.provide(replyLayer(fixture.path, fakeAnswerLayer(100))),
      Effect.scoped,
      Effect.ensuring(Effect.promise(() => fixture.close()))
    )
  })
)
it("rejects an assistant using a UUID spelling variant of its own input", () => {
  expect(() =>
    Schema.decodeUnknownSync(DeliveryPayload)({
      deliveryId: id,
      responseId: id,
      inputDeliveryId: id.toUpperCase(),
      role: "assistant",
      outcome: "completed",
      text: "forged"
    })
  ).toThrow()
})

it.effect("deduplicates UUID aliases through the plain Memory application port", () =>
  Effect.gen(function* () {
    const fixture = yield* Effect.promise(temporaryDatabase)
    yield* Effect.gen(function* () {
      const memory = yield* Memory
      const first = yield* memory.append({ deliveryId: id.toUpperCase(), text: "Mixed Case" })
      expect(yield* memory.append({ deliveryId: id, text: "Mixed Case" })).toEqual(first)
      expect((yield* memory.find(id.toUpperCase()))?.state).toBe("Accepted")
      expect(yield* memory.page(undefined, 100)).toHaveLength(1)
    }).pipe(
      Effect.provide(memoryLayer(fixture.path)),
      Effect.scoped,
      Effect.ensuring(Effect.promise(() => fixture.close()))
    )
  })
)

it.effect("rejects a user delivery alias of an accepted assistant without interrupting the active turn", () =>
  Effect.gen(function* () {
    const fixture = yield* Effect.promise(temporaryDatabase)
    yield* Effect.gen(function* () {
      const conversation = yield* Conversation
      yield* conversation.send({ deliveryId: id.toUpperCase(), text: "first" })
      yield* conversation.observeReply(id)
      yield* TestClock.adjust(1000)
      const completed = yield* conversation.reply(id.toUpperCase())
      expect(completed.state).toBe("Completed")
      yield* conversation.send({ deliveryId: second, text: "newer" })
      expect(
        (yield* Effect.flip(
          conversation.send({ deliveryId: completed.responseId.toUpperCase(), text: completed.text })
        ))._tag
      ).toBe("DeliveryConflict")
      expect((yield* conversation.reply(second)).state).not.toBe("Interrupted")
      expect((yield* conversation.page({ limit: 100 })).messages).toHaveLength(3)
    }).pipe(
      Effect.provide(replyLayer(fixture.path, fakeAnswerLayer(10))),
      Effect.scoped,
      Effect.ensuring(Effect.promise(() => fixture.close()))
    )
  })
)
