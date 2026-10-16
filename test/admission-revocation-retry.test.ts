import type { Storage } from "@firfi/unii"
import { Effect, Layer, Stream } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import { AnswerGeneration, type AnswerEvent } from "../src/answer-generation/index.ts"
import { decoratedConversation, temporaryDatabase } from "./memory-fixture.ts"

for (const mode of ["send", "submit"] as const) {
  it(`fails admission after one interrupted write failure and retries through explicit ${mode} only`, async () => {
    const database = await temporaryDatabase()
    let interruptedWrites = 0
    const answer = Layer.succeed(AnswerGeneration, {
      capabilities: { languages: ["en"], output: "text-deltas" },
      generate: () =>
        Stream.concat(
          Stream.succeed({ kind: "Delta", text: "frozen output", languageSpans: [] } satisfies AnswerEvent),
          Stream.never
        )
    })
    const decorate = (storage: Storage): Storage => ({
      open: () => storage.open(),
      close: () => storage.close(),
      load: () => storage.load(),
      appendNode: (node) => storage.appendNode(node),
      checkpoint: (value) => storage.checkpoint(value),
      appendRecords: async (records) => {
        if (records.some((record) => record.kind === "assistant_interrupted")) {
          interruptedWrites += 1
          if (interruptedWrites === 1) throw new Error("First interrupted write fails; any hidden retry would succeed")
        }
        await storage.appendRecords(records)
      }
    })
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const conversation = yield* Conversation
            const first = { deliveryId: crypto.randomUUID(), text: "first input" }
            const second = { deliveryId: crypto.randomUUID(), text: "second input" }
            yield* conversation.send(first)
            yield* conversation.observeReply(first.deliveryId)
            let reply = yield* conversation.reply(first.deliveryId)
            for (let i = 0; reply.state !== "Streaming" && i < 100; i++) {
              yield* Effect.sleep(5)
              reply = yield* conversation.reply(first.deliveryId)
            }
            expect(reply.state).toBe("Streaming")
            expect(reply.text).toBe("frozen output")
            const reservation = mode === "submit" ? yield* conversation.registerInput({ message: second }) : undefined
            const submit = () =>
              reservation === undefined ? conversation.send(second) : conversation.submitInput(reservation)
            expect((yield* submit().pipe(Effect.result))._tag).toBe("Failure")
            expect(interruptedWrites).toBe(1)
            expect((yield* conversation.page({ limit: 100 })).messages.map((row) => row.text)).toEqual([first.text])
            const receipt = yield* submit()
            expect(receipt.text).toBe(second.text)
            expect(interruptedWrites).toBe(2)
            expect((yield* conversation.reply(first.deliveryId)).text).toBe("frozen output")
            expect((yield* conversation.page({ limit: 100 })).messages.map((row) => row.text)).toEqual([
              first.text,
              "frozen output",
              second.text
            ])
          })
        ).pipe(Effect.provide(decoratedConversation(database.path, decorate, answer)))
      )
    } finally {
      await database.close()
    }
  })
}
