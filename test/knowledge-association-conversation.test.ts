import { Effect, Schema } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import { NeighborhoodPage } from "../src/personal-knowledge/index.ts"
import { knowledgeAnswerLayer } from "./knowledge-answer-fixture.ts"
import { answer, lastToolResult, tool } from "./knowledge-tool-frames.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { replyLayer, waitForReply } from "./reply-fixture.ts"

const expression = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const concept = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const association = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const inputId = "11111111-1111-4111-8111-111111111111"
const laterId = "22222222-2222-4222-8222-222222222222"
const query = { id: expression, depth: 1, direction: "outgoing", limit: 10 }
it("uses a typed personal association in a reply and recalls its endpoints and metadata after restart", async () => {
  const database = await temporaryDatabase()
  let calls = 0
  const provider = knowledgeAnswerLayer(async (request) => {
    calls++
    if (calls === 1)
      return tool(
        "apply_knowledge",
        {
          reason: "Keep a personal French mnemonic",
          types: [
            { name: "Expression", fields: [{ name: "text", kind: "string", required: true }] },
            { name: "Concept", fields: [{ name: "label", kind: "string", required: true }] }
          ],
          creates: [
            { id: expression, type: "Expression", values: { text: "pain" } },
            { id: concept, type: "Concept", values: { label: "bread on my breakfast table" } }
          ],
          updates: [],
          relationTypes: [
            {
              name: "PersonalMnemonic",
              sources: ["Expression"],
              targets: ["Concept"],
              fields: [{ name: "cue", kind: "string", required: true }]
            }
          ],
          relationCreates: [
            {
              id: association,
              type: "PersonalMnemonic",
              source: expression,
              target: concept,
              values: { cue: "Imagine breakfast in Paris" }
            }
          ]
        },
        "keep-mnemonic"
      )
    if (calls === 2) {
      expect(lastToolResult(request)).toMatchObject({ revision: 1, createdRelationIds: [association] })
      return tool("query_knowledge_neighborhood", query, "use-mnemonic")
    }
    if (calls === 4) return tool("query_knowledge_neighborhood", query, "recall-mnemonic")
    const result = lastToolResult(request)
    expect(result).toMatchObject({
      revision: 1,
      schema: { relations: [{ name: "PersonalMnemonic", sources: ["Expression"], targets: ["Concept"] }] },
      entities: expect.arrayContaining([
        { id: concept, type: "Concept", values: { label: "bread on my breakfast table" } }
      ]),
      relations: [
        {
          id: association,
          type: "PersonalMnemonic",
          source: expression,
          target: concept,
          values: { cue: "Imagine breakfast in Paris" }
        }
      ],
      nextAfter: null,
      truncated: false
    })
    const page = Schema.decodeUnknownSync(NeighborhoodPage)(result)
    const cue = page.relations[0]?.values.cue
    const word = page.root.values.text
    if (typeof cue !== "string" || typeof word !== "string") throw new Error("Missing stored mnemonic values")
    return answer(`${cue}: which French word means bread? Your personal cue is ${word}.`)
  })
  const application = replyLayer(database.path, provider, {
    answerProvider: "subscription",
    answerModel: "gpt-6.1-sol"
  })
  try {
    for (const deliveryId of [inputId, laterId]) {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const conversation = yield* Conversation
            yield* conversation.send({ deliveryId, text: "Use my personal French mnemonic for an exercise." })
            const reply = yield* waitForReply(conversation, deliveryId)
            expect(reply.state).toBe("Completed")
            expect(reply.text).toContain("breakfast in Paris")
          })
        ).pipe(Effect.provide(application))
      )
    }
    expect(calls).toBe(5)
  } finally {
    await database.close()
  }
})
