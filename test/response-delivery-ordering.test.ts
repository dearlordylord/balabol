import { it } from "@effect/vitest"
import { Clock, Effect } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vitest"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { Conversation } from "../src/conversation/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { replyLayer } from "./reply-fixture.ts"

const orderings: readonly ("CompletionFirst" | "DeadlineFirst")[] = ["CompletionFirst", "DeadlineFirst"]
for (const ordering of orderings)
  it.effect(`retains the selected delivery outcome when ${ordering}`, () =>
    Effect.gen(function* () {
      const database = yield* Effect.promise(temporaryDatabase)
      yield* Effect.gen(function* () {
        const conversation = yield* Conversation
        const registration = yield* conversation.registerReplyDelivery({ completionMillis: 1000 })
        const input = yield* conversation.send({ deliveryId: crypto.randomUUID(), text: "delivery ordering" })
        let generated = yield* conversation.reply(input.deliveryId)
        for (let poll = 0; generated.state !== "Delivering" && poll < 2000; poll++) {
          yield* TestClock.adjust(1)
          generated = yield* conversation.reply(input.deliveryId)
        }
        expect(generated.state).toBe("Delivering")
        const ticket = yield* conversation.deliverySnapshot(registration.registrationId)
        if (ticket === null) throw new Error("Missing authorized delivery ticket")
        const authorization = conversation.replyDeliveryAuthorization(ticket)
        expect(authorization.isAuthorized()).toBe(true)
        expect(
          yield* conversation.settleReplyDelivery({ ...ticket, deliveryId: crypto.randomUUID(), outcome: "Completed" })
        ).toBeNull()
        expect((yield* conversation.reply(input.deliveryId)).state).toBe("Delivering")
        expect(authorization.isAuthorized()).toBe(true)

        if (ordering === "CompletionFirst") {
          const completed = yield* conversation.settleReplyDelivery({ ...ticket, outcome: "Completed" })
          expect(completed?.state).toBe("Completed")
        }
        const now = yield* Clock.currentTimeMillis
        yield* TestClock.adjust(Math.max(0, ticket.deadlineAt - now) + 1)
        let terminal = yield* conversation.reply(input.deliveryId)
        for (let poll = 0; terminal.state === "Delivering" && poll < 2000; poll++) {
          yield* TestClock.adjust(1)
          terminal = yield* conversation.reply(input.deliveryId)
        }
        const outcome = ordering === "CompletionFirst" ? "Completed" : "Failed"
        expect(terminal.state).toBe(outcome)
        if (ordering === "DeadlineFirst") expect(terminal.error?.reason).toBe("DeliveryDeadline")
        else expect(terminal.error).toBeNull()
        expect(terminal.text).toBe(generated.text)
        expect(terminal.receipt?.outcome).toBe(ordering === "CompletionFirst" ? "completed" : "interrupted")
        expect(authorization.isAuthorized()).toBe(false)
        expect(authorization.signal.aborted).toBe(true)
        expect(yield* conversation.settleReplyDelivery({ ...ticket, outcome: "Completed" })).toBeNull()
        expect(yield* conversation.reply(input.deliveryId)).toEqual(terminal)
        expect((yield* conversation.page({ limit: 100 })).messages).toEqual([input, terminal.receipt])
      }).pipe(
        Effect.provide(replyLayer(database.path, fakeAnswerLayer(0))),
        Effect.scoped,
        Effect.ensuring(Effect.promise(() => database.close()))
      )
    })
  )
