import { Prompt } from "effect/ai"
import { subscriptionPromptInputs } from "../src/answer-generation/subscription.ts"
import { Effect } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import type { ToolInferenceTransport } from "../src/subscription/index.ts"
import { knowledgeAnswerLayer } from "./knowledge-answer-fixture.ts"
import { answer, lastToolResult, tool } from "./knowledge-tool-frames.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { replyLayer, waitForReply } from "./reply-fixture.ts"

it("projects all eight declared tools to object-root provider schemas while retaining native parameter validation", async () => {
  const database = await temporaryDatabase()
  let calls = 0
  const transport: ToolInferenceTransport = async (request) => {
    calls++
    expect(request.tools.map((definition) => definition.name).sort()).toEqual([
      "apply_knowledge",
      "inspect_knowledge",
      "inspect_knowledge_difference",
      "inspect_knowledge_history",
      "inspect_knowledge_operations",
      "lookup_dictionary",
      "query_knowledge",
      "query_knowledge_neighborhood"
    ])
    for (const definition of request.tools) {
      expect(definition.parameters).toMatchObject({ type: "object" })
      expect(JSON.stringify(definition.parameters)).not.toContain('"not":')
      expect(JSON.stringify(definition.parameters)).not.toContain('"allOf":')
    }
    expect(request.tools.find((definition) => definition.name === "inspect_knowledge")).toMatchObject({
      strict: true,
      parameters: { type: "object", properties: {}, additionalProperties: false }
    })
    expect(request.tools.find((definition) => definition.name === "apply_knowledge")).toMatchObject({
      strict: false,
      parameters: {
        required: ["reason", "types", "creates", "updates"],
        properties: { creates: { items: { properties: { values: { type: "object" } } } } }
      }
    })
    expect(request.tools.find((definition) => definition.name === "query_knowledge")).toMatchObject({
      strict: false,
      parameters: { required: ["limit"], properties: { limit: { minimum: 1, maximum: 100 } } }
    })
    expect(request.tools.find((definition) => definition.name === "lookup_dictionary")).toMatchObject({
      strict: false,
      parameters: {
        required: ["language", "word"],
        properties: {
          language: { type: "string", maxLength: 16 },
          word: { type: "string", minLength: 1, maxLength: 512 },
          offset: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
          limit: { type: "integer", minimum: 1, maximum: 10 }
        }
      }
    })
    if (calls === 1) return tool("query_knowledge", { limit: 0 }, "invalid-query-limit")
    if (calls === 2) {
      expect(lastToolResult(request)).toMatchObject({
        _tag: "AiError",
        reason: { _tag: "ToolParameterValidationError" }
      })
      return tool("query_knowledge", { limit: 10 }, "correct-query-limit")
    }
    expect(lastToolResult(request)).toMatchObject({ revision: 0, entities: [] })
    return answer("The validated query found no saved entities.")
  }
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          const input = { deliveryId: "11111111-1111-4111-8111-111111111111", text: "Inspect my saved entities." }
          yield* conversation.send(input)
          const reply = yield* waitForReply(conversation, input.deliveryId)
          expect(reply.state).toBe("Completed")
          expect(reply.text).toBe("The validated query found no saved entities.")
        })
      ).pipe(
        Effect.provide(
          replyLayer(database.path, knowledgeAnswerLayer(transport), {
            answerProvider: "subscription",
            answerModel: "gpt-6.1-sol"
          })
        )
      )
    )
    expect(calls).toBe(3)
  } finally {
    await database.close()
  }
})

const opaque = { type: "reasoning", id: "rs_fallback", summary: [], encrypted_content: "opaque-fixture" }
it("projects native fallback assistant reasoning, calls and separate tool results without a terminal manifest", () => {
  const prompt = Prompt.fromMessages([
    Prompt.makeMessage("assistant", {
      content: [
        Prompt.makePart("reasoning", { text: "", options: { balabolSubscription: { reasoningItem: opaque } } }),
        Prompt.makePart("text", { text: "Checking. " }),
        Prompt.makePart("tool-call", {
          id: "call_fallback",
          name: "inspect_knowledge",
          params: {},
          providerExecuted: false
        })
      ]
    }),
    Prompt.makeMessage("tool", {
      content: [
        Prompt.makePart("tool-result", {
          id: "call_fallback",
          name: "inspect_knowledge",
          result: { revision: 0 },
          isFailure: false,
          providerExecuted: false
        })
      ]
    })
  ])
  expect(subscriptionPromptInputs(prompt)).toEqual([
    opaque,
    { role: "assistant", content: "Checking. " },
    { type: "function_call", call_id: "call_fallback", name: "inspect_knowledge", arguments: "{}" },
    { type: "function_call_output", call_id: "call_fallback", output: '{"revision":0}' }
  ])
})
it.each([
  { label: "missing opaque metadata", options: {} },
  {
    label: "forged ciphertext type",
    options: { balabolSubscription: { reasoningItem: { ...opaque, encrypted_content: 7 } } }
  }
])("rejects fallback reasoning with $label at provider request normalization", ({ options }) => {
  const prompt = Prompt.fromMessages([
    Prompt.makeMessage("assistant", { content: [Prompt.makePart("reasoning", { text: "", options })] })
  ])
  expect(() => subscriptionPromptInputs(prompt)).toThrow()
})
it("rejects unsupported native file content rather than silently dropping it", () => {
  const prompt = Prompt.fromMessages([
    Prompt.makeMessage("user", { content: [Prompt.makePart("file", { mediaType: "text/plain", data: "fixture" })] })
  ])
  expect(() => subscriptionPromptInputs(prompt)).toThrow("Unsupported subscription prompt content")
})
