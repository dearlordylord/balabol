import { Effect, Layer, Schema } from "effect"
import { expect, it } from "vitest"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { Conversation, ReplyConfiguration, defaultReplySettings } from "../src/conversation/index.ts"
import { Memory, Receipt, sqliteLayer, uniiLayer, type DeliveryPayload } from "../src/memory/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"

type ReceiptFault = "text" | "outcome" | "identity"
const faults: readonly ReceiptFault[] = ["text", "outcome", "identity"]
const wrongReceipt = (payload: DeliveryPayload, fault: ReceiptFault): Receipt => {
  const identity = crypto.randomUUID()
  const changes =
    fault === "text"
      ? { text: `${payload.text} altered` }
      : fault === "outcome"
        ? { outcome: "interrupted" }
        : { deliveryId: identity, responseId: identity }
  return Schema.decodeUnknownSync(Receipt)({ ...payload, ...changes, recordId: 0, position: 0 })
}
const waitForDelivery = (conversation: Conversation["Service"], inputDeliveryId: string) =>
  Effect.gen(function* () {
    let reply = yield* conversation.reply(inputDeliveryId)
    for (let attempt = 0; reply.state !== "Delivering" && attempt < 100; attempt++) {
      yield* Effect.sleep(5)
      reply = yield* conversation.reply(inputDeliveryId)
    }
    expect(reply.state).toBe("Delivering")
    return reply
  })

it.each(faults)(
  "rejects a successful append receipt with wrong %s and retries the exact selected completion",
  async (fault) => {
    const database = await temporaryDatabase()
    let corrupting = true
    let attempts: readonly DeliveryPayload[] = []
    try {
      const memory = Layer.effect(
        Memory,
        Effect.gen(function* () {
          const real = yield* Memory
          return Memory.of({
            ...real,
            append: (payload) =>
              payload.role !== "assistant"
                ? real.append(payload)
                : Effect.suspend(() => {
                    attempts = [...attempts, structuredClone(payload)]
                    return corrupting ? Effect.succeed(wrongReceipt(payload, fault)) : real.append(payload)
                  })
          })
        })
      ).pipe(Layer.provide(uniiLayer.pipe(Layer.provide(sqliteLayer(database.path)))))
      const application = Conversation.configuredLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            memory,
            fakeAnswerLayer(0),
            Layer.succeed(ReplyConfiguration, { ...defaultReplySettings, attachmentMillis: 60000 })
          )
        )
      )
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const conversation = yield* Conversation
            const registration = yield* conversation.registerReplyDelivery({ completionMillis: 60000 })
            const input = yield* conversation.send({
              deliveryId: crypto.randomUUID(),
              text: "retain the chosen completion"
            })
            const generated = yield* waitForDelivery(conversation, input.deliveryId)
            const ticket = yield* conversation.deliverySnapshot(registration.registrationId)
            if (ticket === null) throw new Error("Missing enrolled delivery")
            const failed = yield* conversation
              .settleReplyDelivery({ ...ticket, outcome: "Completed" })
              .pipe(Effect.result)
            expect(failed._tag).toBe("Failure")
            if (failed._tag === "Failure") expect(failed.failure._tag).toBe("StorageUnavailable")
            expect((yield* conversation.reply(input.deliveryId)).state).toBe("Failed")
            expect((yield* conversation.page({ limit: 100 })).messages).toEqual([input])
            expect(attempts).toHaveLength(1)
            const selected = attempts[0]
            if (selected === undefined) throw new Error("Missing selected persistence intent")
            expect(selected.outcome).toBe("completed")
            expect(selected.text).toBe(generated.text)

            corrupting = false
            const recovered = yield* conversation.interruptResponse(ticket)
            expect(recovered?.state).toBe("Completed")
            expect(recovered?.text).toBe(generated.text)
            expect(recovered?.receipt?.outcome).toBe("completed")
            expect(attempts).toEqual([selected, selected])
            expect(yield* conversation.receipt(selected.deliveryId)).toEqual(recovered?.receipt)
            expect((yield* conversation.page({ limit: 100 })).messages).toEqual([input, recovered?.receipt])
          })
        ).pipe(Effect.provide(application))
      )
    } finally {
      await database.close()
    }
  }
)
