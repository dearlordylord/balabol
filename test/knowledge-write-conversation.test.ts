import { Effect } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import type { ToolInferenceTransport } from "../src/subscription/index.ts"
import { knowledgeAnswerLayer } from "./knowledge-answer-fixture.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { replyLayer, waitForReply } from "./reply-fixture.ts"
import { answer, lastToolResult, tool } from "./knowledge-tool-frames.ts"
const entityId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const inputId = "11111111-1111-4111-8111-111111111111"
const laterId = "22222222-2222-4222-8222-222222222222"
it("creates explicit personal types and recalls the same typed knowledge after backend restart", async () => {
  const database = await temporaryDatabase()
  let calls = 0
  const transport: ToolInferenceTransport = async (request) => {
    calls++
    if (calls === 1)
      return tool(
        "apply_knowledge",
        {
          reason: "Keep the user's selected French expression",
          types: [
            {
              name: "Expression",
              fields: [
                { name: "text", kind: "string", required: true },
                { name: "language", kind: "string", required: true }
              ]
            }
          ],
          creates: [{ id: entityId, type: "Expression", values: { text: "pain", language: "fr" } }],
          updates: []
        },
        "save-expression"
      )
    if (calls === 2) {
      expect(lastToolResult(request)).toMatchObject({ revision: 1, createdIds: [entityId] })
      return answer("Saved the French expression pain.")
    }
    if (calls === 3) return tool("query_knowledge", { id: entityId, limit: 10 }, "recall-expression")
    expect(lastToolResult(request)).toMatchObject({
      revision: 1,
      entities: [{ id: entityId, type: "Expression", values: { text: "pain", language: "fr" } }]
    })
    return answer("Your saved French expression is pain.")
  }
  const application = replyLayer(database.path, knowledgeAnswerLayer(transport), {
    answerProvider: "subscription",
    answerModel: "gpt-6.1-sol"
  })
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          yield* conversation.send({ deliveryId: inputId, text: "Keep French pain in my vocabulary." })
          expect((yield* waitForReply(conversation, inputId)).text).toBe("Saved the French expression pain.")
        })
      ).pipe(Effect.provide(application))
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          yield* conversation.send({ deliveryId: laterId, text: "Recall my saved expression." })
          expect((yield* waitForReply(conversation, laterId)).text).toBe("Your saved French expression is pain.")
          expect((yield* conversation.page({ limit: 100 })).messages).toHaveLength(4)
        })
      ).pipe(Effect.provide(application))
    )
    expect(calls).toBe(4)
  } finally {
    await database.close()
  }
})
