import { Effect } from "effect"
import { expect, it } from "vitest"
import { conversationLayer } from "../src/bootstrap/index.ts"
import { Conversation } from "../src/conversation/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"

it("streams a fake response then durably exposes it as assistant history", async () => {
  const fixture = await temporaryDatabase()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          const input = { deliveryId: "33333333-3333-4333-8333-333333333333", text: "bonjour" }
          yield* conversation.send(input)
          let response = yield* conversation.reply(input.deliveryId)
          for (let attempt = 0; response.state !== "Completed" && attempt < 100; attempt++) {
            yield* Effect.sleep(20)
            response = yield* conversation.reply(input.deliveryId)
          }
          expect(response.state).toBe("Completed")
          expect(response.text).toBe("This is a fixture reply.")
          expect((yield* conversation.page({ limit: 100 })).messages.map((message) => message.role)).toEqual([
            "user",
            "assistant"
          ])
        })
      ).pipe(Effect.provide(conversationLayer(fixture.path)))
    )
  } finally {
    await fixture.close()
  }
})
