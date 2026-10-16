import { Deferred, Effect, Stream } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import type { DeliveryTicket } from "../src/conversation/index.ts"
import { conversationLayer } from "../src/bootstrap/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
const input = { deliveryId: "11111111-1111-4111-8111-111111111111", text: "Hello" }
it("enrolls delivery before generation and defers the sole completed receipt until settlement", async () => {
  const database = await temporaryDatabase()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          const started = yield* Deferred.make<DeliveryTicket>()
          const registration = yield* conversation.registerReplyDelivery({ completionMillis: 5000 })
          yield* registration.updates.pipe(
            Stream.runForEach((update) =>
              update.kind === "Started" ? Deferred.succeed(started, update.ticket).pipe(Effect.asVoid) : Effect.void
            ),
            Effect.forkIn(yield* Effect.scope)
          )
          yield* conversation.send(input)
          const announced = yield* Deferred.await(started).pipe(Effect.timeout("2 seconds"))
          expect(announced.inputDeliveryId).toBe(input.deliveryId)
          yield* Effect.sleep(100)
          const generated = yield* conversation.reply(input.deliveryId)
          expect(generated.state).toBe("Delivering")
          expect(generated.receipt).toBeNull()
          const ticket = yield* conversation.deliverySnapshot(registration.registrationId)
          expect(ticket).toEqual(announced)
          if (ticket === null) throw new Error("Missing enrolled reply")
          const completed = yield* conversation.settleReplyDelivery({ ...ticket, outcome: "Completed" })
          expect(completed?.state).toBe("Completed")
          expect(completed?.receipt?.outcome).toBe("completed")
          expect((yield* conversation.page({ limit: 100 })).messages).toHaveLength(2)
        })
      ).pipe(
        Effect.provide(
          conversationLayer(database.path, {
            answerProvider: "fake",
            answerModel: "sol",
            deltaMillis: 1,
            contextWaitAttempts: 10,
            contextWaitMillis: 1,
            attachmentMillis: 10
          })
        )
      )
    )
  } finally {
    await database.close()
  }
})
