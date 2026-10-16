import { Effect, Option, Stream } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { replyLayer } from "./reply-fixture.ts"

it("atomically subscribes to delivery and retires exact-ticket authorization independently of notification consumption", async () => {
  const database = await temporaryDatabase()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          const delivery = yield* conversation.registerReplyDelivery({ completionMillis: 60000 })
          expect(delivery.snapshot.kind).toBe("Idle")
          const input = yield* conversation.send({ deliveryId: crypto.randomUUID(), text: "spoken reply" })
          const ticket = yield* conversation.deliverySnapshot(delivery.registrationId)
          if (ticket === null) throw new Error("Missing atomic delivery registration")
          expect(ticket.inputDeliveryId).toBe(input.deliveryId)
          const authorization = conversation.replyDeliveryAuthorization(ticket)
          expect(authorization.isAuthorized()).toBe(true)
          expect(authorization.signal.aborted).toBe(false)
          yield* conversation.interruptResponse(ticket)
          expect(authorization.isAuthorized()).toBe(false)
          expect(authorization.signal.aborted).toBe(true)
          yield* conversation.unregisterReplyDelivery(delivery.registrationId)
          const notice = Option.getOrThrow(yield* delivery.updates.pipe(Stream.take(1), Stream.runHead))
          expect(notice.kind).toBe("Invalidated")
          if (notice.kind === "Invalidated") expect(notice.ticket).toEqual(ticket)
        })
      ).pipe(Effect.provide(replyLayer(database.path, fakeAnswerLayer(0))))
    )
  } finally {
    await database.close()
  }
})

it("rejects invalid and competing delivery registration without losing the reusable slot", async () => {
  const database = await temporaryDatabase()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          const invalid = yield* conversation.registerReplyDelivery({ completionMillis: 0 }).pipe(Effect.result)
          expect(invalid._tag).toBe("Failure")
          if (invalid._tag === "Failure") expect(invalid.failure._tag).toBe("InvalidInput")
          const first = yield* conversation.registerReplyDelivery({ completionMillis: 60000 })
          const competing = yield* conversation.registerReplyDelivery({ completionMillis: 60000 }).pipe(Effect.result)
          expect(competing._tag).toBe("Failure")
          if (competing._tag === "Failure") expect(competing.failure._tag).toBe("ReplyBusy")
          const input = yield* conversation.send({ deliveryId: crypto.randomUUID(), text: "original registration" })
          const ticket = yield* conversation.deliverySnapshot(first.registrationId)
          expect(ticket?.inputDeliveryId).toBe(input.deliveryId)
          expect(ticket?.registrationId).toBe(first.registrationId)
          yield* conversation.unregisterReplyDelivery(first.registrationId)
          const replacement = yield* conversation.registerReplyDelivery({ completionMillis: 60000 })
          expect(replacement.registrationId).not.toBe(first.registrationId)
          expect(replacement.snapshot.kind).toBe("Idle")
          yield* conversation.unregisterReplyDelivery(replacement.registrationId)
        })
      ).pipe(Effect.provide(replyLayer(database.path, fakeAnswerLayer(0))))
    )
  } finally {
    await database.close()
  }
})
