import { Effect } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import type { KnowledgeReceipt } from "../src/personal-knowledge/index.ts"
import { knowledgeAnswerLayer } from "./knowledge-answer-fixture.ts"
import { answer, lastToolResult, tool } from "./knowledge-tool-frames.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { replyLayer, waitForReply } from "./reply-fixture.ts"

it("recovers a committed migration after cancellation loses its acknowledgement without rerunning the migration", async () => {
  const database = await temporaryDatabase()
  const seedId = "11111111-1111-4111-8111-111111111111"
  const inputId = "22222222-2222-4222-8222-222222222222"
  const entityId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  let entered: () => void = () => undefined
  const committed = new Promise<void>((resolve) => {
    entered = resolve
  })
  let receipt: KnowledgeReceipt | undefined
  let gated = true
  let calls = 0
  const migration = {
    reason: "Clarify the property name",
    types: [],
    creates: [],
    updates: [],
    migrations: [{ kind: "RenameField", target: "entity", type: "Item", from: "old", to: "new" }]
  }
  const provider = knowledgeAnswerLayer(
    async (request) => {
      calls++
      if (calls === 1)
        return tool(
          "apply_knowledge",
          {
            reason: "Keep original item",
            types: [{ name: "Item", fields: [{ name: "old", kind: "string", required: true }] }],
            creates: [{ id: entityId, type: "Item", values: { old: "value" } }],
            updates: []
          },
          "seed"
        )
      if (calls === 2) return answer("Original item saved.")
      if (calls === 3 || calls === 4) return tool("apply_knowledge", migration, `provider-attempt-${calls}`)
      if (calls === 5) {
        expect(lastToolResult(request)).toEqual(receipt)
        return tool("query_knowledge", { id: entityId, limit: 1 }, "read-migrated")
      }
      expect(lastToolResult(request)).toMatchObject({
        revision: 2,
        entities: [{ id: entityId, values: { new: "value" } }]
      })
      return answer("The renamed property is new, and its value is retained.")
    },
    (durable) => ({
      ...durable,
      commit: (request) =>
        durable.commit(request).pipe(
          Effect.flatMap((accepted) => {
            if (!gated || request.change.migrations?.length === 0 || request.change.migrations === undefined)
              return Effect.succeed(accepted)
            gated = false
            receipt = accepted
            entered()
            return Effect.never
          })
        )
    })
  )
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          yield* conversation.send({ deliveryId: seedId, text: "Keep an original item." })
          expect((yield* waitForReply(conversation, seedId)).state).toBe("Completed")
          yield* conversation.send({ deliveryId: inputId, text: "Rename its old property to new." })
          yield* Effect.promise(() => committed)
          yield* conversation.cancelReply(inputId)
          expect((yield* conversation.reply(inputId)).error?.code).toBe("Cancelled")
          yield* conversation.retryReply(inputId)
          expect((yield* waitForReply(conversation, inputId)).state).toBe("Completed")
        })
      ).pipe(
        Effect.provide(
          replyLayer(database.path, provider, { answerProvider: "subscription", answerModel: "gpt-6.1-sol" })
        )
      )
    )
    expect(calls).toBe(6)
  } finally {
    await database.close()
  }
})
