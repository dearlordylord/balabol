import { Effect } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import { knowledgeAnswerLayer } from "./knowledge-answer-fixture.ts"
import { answer, lastToolResult, tool } from "./knowledge-tool-frames.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { replyLayer, waitForReply } from "./reply-fixture.ts"

const entityId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const relationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
it("migrates entity and relation fields through conversation while old schema/data remain readable after restart", async () => {
  const database = await temporaryDatabase()
  let calls = 0
  const provider = knowledgeAnswerLayer(async (request) => {
    calls++
    if (calls === 1)
      return tool(
        "apply_knowledge",
        {
          reason: "Keep the original expression and personal cue",
          types: [{ name: "Expression", fields: [{ name: "text", kind: "string", required: true }] }],
          creates: [{ id: entityId, type: "Expression", values: { text: "pain" } }],
          updates: [],
          relationTypes: [
            {
              name: "Mnemonic",
              sources: ["Expression"],
              targets: ["Expression"],
              fields: [{ name: "cue", kind: "string", required: true }]
            }
          ],
          relationCreates: [
            { id: relationId, type: "Mnemonic", source: entityId, target: entityId, values: { cue: "Paris" } }
          ]
        },
        "seed"
      )
    if (calls === 2)
      return tool(
        "apply_knowledge",
        {
          reason: "Make names clearer and keep practice metadata",
          types: [],
          creates: [],
          updates: [],
          migrations: [
            {
              kind: "AddField",
              target: "entity",
              type: "Expression",
              field: { name: "practiced", kind: "boolean", required: true },
              default: false
            },
            { kind: "RenameField", target: "entity", type: "Expression", from: "text", to: "word" },
            {
              kind: "AddField",
              target: "relation",
              type: "Mnemonic",
              field: { name: "strength", kind: "number", required: true },
              default: 3
            },
            { kind: "RenameField", target: "relation", type: "Mnemonic", from: "cue", to: "hint" }
          ]
        },
        "evolve"
      )
    if (calls === 3 || calls === 8)
      return tool("query_knowledge_neighborhood", { id: entityId, depth: 1, direction: "both", limit: 10 }, "current")
    if (calls === 4 || calls === 9) {
      expect(lastToolResult(request)).toMatchObject({
        revision: 2,
        root: { id: entityId, values: { word: "pain", practiced: false } },
        relations: [{ id: relationId, values: { hint: "Paris", strength: 3 } }]
      })
      return tool(
        "query_knowledge_neighborhood",
        { id: entityId, revision: 1, depth: 1, direction: "both", limit: 10 },
        "historical"
      )
    }
    if (calls === 5 || calls === 10) {
      expect(lastToolResult(request)).toMatchObject({
        revision: 1,
        root: { id: entityId, values: { text: "pain" } },
        relations: [{ id: relationId, values: { cue: "Paris" } }]
      })
      if (calls === 10) return answer("The original and migrated values both survived restart.")
      return tool("inspect_knowledge_history", { limit: 20 }, "history")
    }
    if (calls === 6) {
      expect(lastToolResult(request)).toMatchObject({
        revisions: [
          { revision: 0, reason: null },
          { revision: 1, reason: "Keep the original expression and personal cue" },
          { revision: 2, reason: "Make names clearer and keep practice metadata" }
        ],
        nextAfterRevision: null
      })
      return tool("inspect_knowledge_difference", { fromRevision: 1, toRevision: 2, limit: 10 }, "difference")
    }
    expect(lastToolResult(request)).toMatchObject({
      from: { revision: 1 },
      to: { revision: 2 },
      changes: expect.arrayContaining([
        {
          kind: "Entity",
          id: entityId,
          type: "Expression",
          change: "updated",
          changedFields: ["practiced", "text", "word"]
        },
        {
          kind: "Relation",
          id: relationId,
          type: "Mnemonic",
          change: "updated",
          changedFields: ["cue", "hint", "strength"],
          endpointsChanged: false
        }
      ]),
      nextAfter: null
    })
    return answer("Your expression is pain; its renamed personal hint is Paris.")
  })
  const application = replyLayer(database.path, provider, {
    answerProvider: "subscription",
    answerModel: "gpt-6.1-sol"
  })
  try {
    for (const deliveryId of ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]) {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const conversation = yield* Conversation
            yield* conversation.send({
              deliveryId,
              text: "Improve my knowledge schema and inspect its original values."
            })
            expect((yield* waitForReply(conversation, deliveryId)).state).toBe("Completed")
          })
        ).pipe(Effect.provide(application))
      )
    }
    expect(calls).toBe(10)
  } finally {
    await database.close()
  }
})
