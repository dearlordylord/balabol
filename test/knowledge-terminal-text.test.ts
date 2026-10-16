import { Effect } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import { knowledgeAnswerLayer } from "./knowledge-answer-fixture.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { replyLayer, waitForReply } from "./reply-fixture.ts"
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
for (const sparse of [false, true])
  it(`fails a ${sparse ? "sparse" : "full"} terminal that contradicts the streamed answer`, async () => {
    const database = await temporaryDatabase()
    const message = {
      type: "message",
      id: "msg_stop",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "NOT SAVED" }]
    }
    const answer = knowledgeAnswerLayer(
      async () =>
        new Response(
          frame({
            type: "response.output_item.added",
            output_index: 0,
            item: { ...message, status: "in_progress", content: [] }
          }) +
            frame({ type: "response.output_text.delta", delta: "SAVED" }) +
            frame({ type: "response.output_item.done", output_index: 0, item: message }) +
            frame({ type: "response.completed", response: { status: "completed", output: sparse ? [] : [message] } })
        )
    )
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const conversation = yield* Conversation
            const input = {
              deliveryId: "11111111-1111-4111-8111-111111111111",
              text: "Report the saved state truthfully."
            }
            yield* conversation.send(input)
            const reply = yield* waitForReply(conversation, input.deliveryId)
            expect(reply.state).toBe("Failed")
            expect(reply.error?.code).toBe("ProviderFailed")
            expect((yield* conversation.receipt(input.deliveryId))?.text).toBe(input.text)
            const transcript = yield* conversation.page({ limit: 100 })
            expect(
              transcript.messages
                .filter((entry) => entry.role === "assistant")
                .every((entry) => entry.outcome === "interrupted")
            ).toBe(true)
          }).pipe(
            Effect.provide(
              replyLayer(database.path, answer, { answerProvider: "subscription", answerModel: "gpt-6.1-sol" })
            )
          )
        )
      )
    } finally {
      await database.close()
    }
  })
