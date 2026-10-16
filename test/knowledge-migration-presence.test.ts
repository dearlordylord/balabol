import { Effect, Schema } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import { NeighborhoodPage, QueryPage, Values } from "../src/personal-knowledge/index.ts"
import type { ToolInferenceTransport } from "../src/subscription/index.ts"
import { knowledgeAnswerLayer } from "./knowledge-answer-fixture.ts"
import { answer, lastToolResult, tool } from "./knowledge-tool-frames.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { replyLayer, waitForReply } from "./reply-fixture.ts"

const id = (number: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${number.toString(16).padStart(12, "0")}`
const names = ["toString", "constructor", "__proto__"]
const fields = names.map((name) => ({ name, kind: "string", required: false }))
const present = Schema.decodeUnknownSync(Values)(
  JSON.parse('{"toString":"literal text","constructor":"literal constructor","__proto__":"literal prototype"}')
)
const renamed = {
  saved_toString: "literal text",
  saved_constructor: "literal constructor",
  saved___proto__: "literal prototype"
}

it("renames only own prototype-named entity and relation values through Conversation while preserving optional absence", async () => {
  const database = await temporaryDatabase()
  let calls = 0
  const transport: ToolInferenceTransport = async (request) => {
    calls++
    if (calls === 1)
      return tool(
        "apply_knowledge",
        {
          reason: "Preserve explicitly named optional scalar fields",
          types: [{ name: "Thing", fields }],
          creates: [
            { id: id(1), type: "Thing", values: {} },
            { id: id(2), type: "Thing", values: present }
          ],
          updates: [],
          relationTypes: [{ name: "Link", sources: ["Thing"], targets: ["Thing"], fields }],
          relationCreates: [
            { id: id(3), type: "Link", source: id(1), target: id(2), values: {} },
            { id: id(4), type: "Link", source: id(2), target: id(1), values: present }
          ]
        },
        "seed-presence"
      )
    if (calls === 2) {
      expect(lastToolResult(request)).toMatchObject({ revision: 1 })
      return tool(
        "apply_knowledge",
        {
          reason: "Rename declared optional fields without inventing inherited values",
          types: [],
          creates: [],
          updates: [],
          migrations: names.flatMap((from) => [
            { kind: "RenameField", target: "entity", type: "Thing", from, to: `saved_${from}` },
            { kind: "RenameField", target: "relation", type: "Link", from, to: `saved_${from}` }
          ])
        },
        "rename-presence"
      )
    }
    if (calls === 3) {
      expect(lastToolResult(request)).toMatchObject({ revision: 2 })
      return tool("query_knowledge", { type: "Thing", limit: 100 }, "read-own-fields")
    }
    if (calls === 4) {
      const page = Schema.decodeUnknownSync(QueryPage)(lastToolResult(request))
      expect(page.entities.map((entity) => entity.values)).toEqual([{}, renamed])
      expect(page.entities.map((entity) => entity.id)).toEqual([id(1), id(2)])
      return tool(
        "query_knowledge_neighborhood",
        { id: id(1), depth: 1, direction: "both", limit: 100 },
        "read-own-relation-fields"
      )
    }
    const page = Schema.decodeUnknownSync(NeighborhoodPage)(lastToolResult(request))
    expect(page.revision).toBe(2)
    expect(page.relations.map((relation) => relation.values)).toEqual([{}, renamed])
    expect(page.relations.map((relation) => [relation.id, relation.source, relation.target])).toEqual([
      [id(3), id(1), id(2)],
      [id(4), id(2), id(1)]
    ])
    return answer("Renamed the explicit scalar values and left absent fields absent.")
  }
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          yield* conversation.send({ deliveryId: id(100), text: "Rename my optional fields without adding values." })
          const reply = yield* waitForReply(conversation, id(100))
          expect(reply.state).toBe("Completed")
          expect(reply.text).toBe("Renamed the explicit scalar values and left absent fields absent.")
        }).pipe(
          Effect.provide(
            replyLayer(database.path, knowledgeAnswerLayer(transport), {
              answerProvider: "subscription",
              answerModel: "gpt-6.1-sol"
            })
          )
        )
      )
    )
  } finally {
    await database.close()
  }
})
