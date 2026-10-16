import { Effect } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import type { ToolInferenceTransport } from "../src/subscription/index.ts"
import { replyLayer, waitForReply } from "./reply-fixture.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { knowledgeAnswerLayer } from "./knowledge-answer-fixture.ts"
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
const call = {
  type: "function_call",
  id: "item-1",
  call_id: "call-1",
  name: "inspect_knowledge",
  arguments: "{}",
  status: "completed"
}
const toolResponse =
  frame({ type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } }) +
  frame({ type: "response.function_call_arguments.delta", item_id: call.id, output_index: 0, delta: "{}" }) +
  frame({ type: "response.function_call_arguments.done", item_id: call.id, output_index: 0, arguments: "{}" }) +
  frame({ type: "response.output_item.done", output_index: 0, item: call }) +
  frame({ type: "response.completed", response: { status: "completed", output: [call] } })
it("the conversation inspects its empty knowledge schema and answers using the actual tool result", async () => {
  const database = await temporaryDatabase()
  let requests = 0
  const transport: ToolInferenceTransport = async (request) => {
    requests++
    expect(request.tools.map((tool) => tool.name).sort()).toEqual([
      "apply_knowledge",
      "inspect_knowledge",
      "inspect_knowledge_difference",
      "inspect_knowledge_history",
      "inspect_knowledge_operations",
      "query_knowledge",
      "query_knowledge_neighborhood"
    ])
    if (requests === 1) return new Response(toolResponse)
    const result = request.input.find((item) => "type" in item && item.type === "function_call_output")
    expect(result).toMatchObject({ call_id: "call-1" })
    if (result === undefined || !("output" in result)) throw new Error("Missing actual tool result")
    expect(JSON.parse(result.output)).toEqual({ revision: 0, schema: { types: [], relations: [] } })
    return new Response(
      frame({ type: "response.output_text.delta", delta: "The knowledge schema is empty at revision zero." }) +
        frame({ type: "response.completed", response: { status: "completed", output: [] } })
    )
  }
  const answer = knowledgeAnswerLayer(transport)
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          const input = { deliveryId: "11111111-1111-4111-8111-111111111111", text: "Inspect my knowledge." }
          yield* conversation.send(input)
          const reply = yield* waitForReply(conversation, input.deliveryId)
          expect(reply.state).toBe("Completed")
          expect(reply.text).toBe("The knowledge schema is empty at revision zero.")
          expect((yield* conversation.page({ limit: 100 })).messages.map((message) => message.text)).toEqual([
            "Inspect my knowledge.",
            "The knowledge schema is empty at revision zero."
          ])
        })
      ).pipe(
        Effect.provide(
          replyLayer(database.path, answer, { answerProvider: "subscription", answerModel: "gpt-6.1-sol" })
        )
      )
    )
    expect(requests).toBe(2)
  } finally {
    await database.close()
  }
})

it("cancels a pending tool-enabled model without losing accepted input or preventing the next reply", async () => {
  const database = await temporaryDatabase()
  let signalStarted: () => void = () => undefined
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve
  })
  let cancelled = false
  let calls = 0
  const answer = knowledgeAnswerLayer(async (_request, _token, signal) => {
    signal.addEventListener(
      "abort",
      () => {
        cancelled = true
      },
      { once: true }
    )
    calls++
    if (calls === 1)
      return new Response(
        new ReadableStream({
          start: () => signalStarted(),
          cancel: () => {
            cancelled = true
          }
        })
      )
    return new Response(
      frame({ type: "response.output_text.delta", delta: "The next answer is healthy." }) +
        frame({ type: "response.completed", response: { status: "completed", output: [] } })
    )
  })
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          const first = { deliveryId: "11111111-1111-4111-8111-111111111111", text: "Inspect knowledge." }
          yield* conversation.send(first)
          yield* Effect.promise(() => started)
          yield* conversation.cancelReply(first.deliveryId)
          expect((yield* conversation.reply(first.deliveryId)).error?.code).toBe("Cancelled")
          expect(cancelled).toBe(true)
          expect((yield* conversation.receipt(first.deliveryId))?.text).toBe("Inspect knowledge.")
          const next = { deliveryId: "22222222-2222-4222-8222-222222222222", text: "Continue." }
          yield* conversation.send(next)
          expect((yield* waitForReply(conversation, next.deliveryId)).text).toBe("The next answer is healthy.")
          expect((yield* conversation.page({ limit: 100 })).messages).toHaveLength(3)
        })
      ).pipe(
        Effect.provide(
          replyLayer(database.path, answer, { answerProvider: "subscription", answerModel: "gpt-6.1-sol" })
        )
      )
    )
    expect(calls).toBe(2)
  } finally {
    await database.close()
  }
})

it("bounds a model that repeatedly requests knowledge instead of completing an answer", async () => {
  const database = await temporaryDatabase()
  let calls = 0
  const answer = knowledgeAnswerLayer(async () => {
    calls++
    return new Response(toolResponse.replaceAll("item-1", `item-${calls}`).replaceAll("call-1", `call-${calls}`))
  })
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          const input = { deliveryId: "11111111-1111-4111-8111-111111111111", text: "Inspect repeatedly." }
          yield* conversation.send(input)
          expect((yield* waitForReply(conversation, input.deliveryId)).state).toBe("Failed")
          expect((yield* conversation.receipt(input.deliveryId))?.text).toBe("Inspect repeatedly.")
          expect((yield* conversation.page({ limit: 100 })).messages).toHaveLength(1)
        })
      ).pipe(
        Effect.provide(
          replyLayer(database.path, answer, { answerProvider: "subscription", answerModel: "gpt-6.1-sol" })
        )
      )
    )
    expect(calls).toBe(8)
  } finally {
    await database.close()
  }
})
