import { Effect } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import type { ToolInferenceTransport } from "../src/subscription/index.ts"
import { knowledgeAnswerLayer } from "./knowledge-answer-fixture.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { replyLayer, waitForReply } from "./reply-fixture.ts"
import { answer, lastToolResult, tool } from "./knowledge-tool-frames.ts"

const firstId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const secondId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const taskId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const inputId = "11111111-1111-4111-8111-111111111111"
const expressionType = {
  name: "Expression",
  fields: [
    { name: "text", kind: "string", required: true },
    { name: "pronunciation", kind: "string", required: false }
  ]
}
const scenario = async (transport: ToolInferenceTransport) => {
  const database = await temporaryDatabase()
  try {
    return await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          yield* conversation.send({ deliveryId: inputId, text: "Keep these personal facts and verify the result." })
          const reply = yield* waitForReply(conversation, inputId)
          expect(reply.state).toBe("Completed")
          const history = yield* conversation.page({ limit: 100 })
          expect(history.messages.map((message) => message.text)).toEqual([
            "Keep these personal facts and verify the result.",
            reply.text
          ])
          return reply.text
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
  } finally {
    await database.close()
  }
}

it("keeps multilingual equal values under distinct IDs and updates typed entities without retaining removed optional fields", async () => {
  let calls = 0
  const text = "日本語 / pain / хлеб"
  const result = await scenario(async (request) => {
    calls++
    if (calls === 1)
      return tool(
        "apply_knowledge",
        {
          reason: "Remember two separately identified expressions and a personal task",
          types: [
            expressionType,
            {
              name: "Task",
              fields: [
                { name: "title", kind: "string", required: true },
                { name: "done", kind: "boolean", required: true },
                { name: "priority", kind: "number", required: true }
              ]
            }
          ],
          creates: [
            { id: firstId, type: "Expression", values: { text, pronunciation: "practice" } },
            { id: secondId, type: "Expression", values: { text } },
            { id: taskId, type: "Task", values: { title: "Renew passport", done: false, priority: 3 } }
          ],
          updates: []
        },
        "create-personal-facts"
      )
    if (calls === 2) {
      expect(lastToolResult(request)).toMatchObject({ revision: 1, createdIds: [firstId, secondId, taskId] })
      return tool(
        "apply_knowledge",
        {
          reason: "Replace the expression fields and complete the task",
          types: [],
          creates: [],
          updates: [
            { id: firstId, values: { text } },
            { id: taskId, values: { title: "Renew passport", done: true, priority: 3 } }
          ]
        },
        "update-personal-facts"
      )
    }
    if (calls === 3) {
      expect(lastToolResult(request)).toMatchObject({ revision: 2, updatedIds: [firstId, taskId] })
      return tool("query_knowledge", { limit: 10 }, "verify-personal-facts")
    }
    expect(lastToolResult(request)).toMatchObject({
      revision: 2,
      entities: [
        { id: firstId, type: "Expression", values: { text } },
        { id: secondId, type: "Expression", values: { text } },
        { id: taskId, type: "Task", values: { title: "Renew passport", done: true, priority: 3 } }
      ]
    })
    const page = lastToolResult(request)
    expect(JSON.stringify(page)).not.toContain('pronunciation":"practice')
    return answer("Both expressions remain separate, and the passport task is complete.")
  })
  expect(result).toBe("Both expressions remain separate, and the passport task is complete.")
  expect(calls).toBe(4)
})

const domainRejections = [
  {
    label: "duplicate schema fields",
    type: { name: "Expression", fields: [expressionType.fields[0], expressionType.fields[0]] },
    entityType: "Expression",
    values: { text: "pain" },
    message: "unique"
  },
  {
    label: "a missing required value",
    type: expressionType,
    entityType: "Expression",
    values: {},
    message: "required field text"
  },
  {
    label: "an undeclared field",
    type: expressionType,
    entityType: "Expression",
    values: { text: "pain", note: "untyped fallback" },
    message: "undeclared field note"
  },
  {
    label: "a wrong scalar kind",
    type: expressionType,
    entityType: "Expression",
    values: { text: 7 },
    message: "text requires string"
  },
  {
    label: "an undeclared entity type",
    type: expressionType,
    entityType: "Undeclared",
    values: { text: "pain" },
    message: "undeclared type Undeclared"
  }
]
const invalidCases = [
  ...domainRejections.map((rejection) => ({ ...rejection, tag: "KnowledgeRejected" })),
  {
    label: "an unsupported schema field kind",
    type: { name: "Expression", fields: [{ name: "text", kind: "object", required: true }] },
    entityType: "Expression",
    values: { text: "pain" },
    message: "ToolParameterValidationError",
    tag: "AiError"
  }
]
it.each(invalidCases)(
  "returns an actionable rejection for $label, preserves the whole batch and accepts the model's correction",
  async ({ entityType, message, tag, type, values }) => {
    let calls = 0
    const result = await scenario(async (request) => {
      calls++
      if (calls === 1)
        return tool(
          "apply_knowledge",
          {
            reason: "Attempt a two-entity atomic change",
            types: [type],
            creates: [
              { id: firstId, type: "Expression", values: { text: "valid first entity" } },
              { id: secondId, type: entityType, values }
            ],
            updates: []
          },
          "invalid-batch"
        )
      if (calls === 2) {
        expect(lastToolResult(request)).toMatchObject({ _tag: tag })
        expect(JSON.stringify(lastToolResult(request))).toContain(message)
        return tool("inspect_knowledge", {}, "inspect-after-rejection")
      }
      if (calls === 3) {
        expect(lastToolResult(request)).toEqual({ revision: 0, schema: { types: [], relations: [] } })
        return tool(
          "apply_knowledge",
          {
            reason: "Correct the rejected batch",
            types: [expressionType],
            creates: [
              { id: firstId, type: "Expression", values: { text: "valid first entity" } },
              { id: secondId, type: "Expression", values: { text: "pain" } }
            ],
            updates: []
          },
          "corrected-batch"
        )
      }
      if (calls === 4) {
        expect(lastToolResult(request)).toMatchObject({ revision: 1, createdIds: [firstId, secondId] })
        return tool("query_knowledge", { type: "Expression", limit: 10 }, "verify-correction")
      }
      expect(lastToolResult(request)).toMatchObject({
        revision: 1,
        entities: [
          { id: firstId, values: { text: "valid first entity" } },
          { id: secondId, values: { text: "pain" } }
        ]
      })
      return answer("The rejected batch changed nothing; the corrected facts are saved.")
    })
    expect(result).toBe("The rejected batch changed nothing; the corrected facts are saved.")
    expect(calls).toBe(5)
  }
)
