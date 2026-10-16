import { Effect } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import type { ToolInferenceTransport } from "../src/subscription/index.ts"
import { knowledgeAnswerLayer } from "./knowledge-answer-fixture.ts"
import { answer, frame, lastToolResult } from "./knowledge-tool-frames.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { replyLayer, waitForReply } from "./reply-fixture.ts"

it("replays committed opaque reasoning in native assistant order across a tool step while delivering only the human reply", async () => {
  const database = await temporaryDatabase()
  const reasoning = {
    type: "reasoning",
    id: `rs_${"x".repeat(140)}`,
    summary: [
      { type: "summary_text", text: "Private fixture summary one" },
      { type: "summary_text", text: "Private fixture summary two" }
    ],
    encrypted_content: "opaque-encrypted-fixture-do-not-display"
  }
  const call = {
    type: "function_call",
    id: "fc_inspect",
    call_id: "call_inspect",
    name: "inspect_knowledge",
    arguments: "{}",
    status: "completed"
  }
  let calls = 0
  const transport: ToolInferenceTransport = async (request) => {
    calls++
    if (calls === 1)
      return new Response(
        frame({
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "reasoning", id: reasoning.id, summary: [], status: "in_progress" }
        }) +
          frame({ type: "response.output_item.done", output_index: 0, item: { ...reasoning, status: "completed" } }) +
          frame({
            type: "response.output_item.added",
            output_index: 1,
            item: { ...call, arguments: "", status: "in_progress" }
          }) +
          frame({
            type: "response.function_call_arguments.delta",
            item_id: call.id,
            output_index: 1,
            delta: call.arguments
          }) +
          frame({
            type: "response.function_call_arguments.done",
            item_id: call.id,
            output_index: 1,
            arguments: call.arguments
          }) +
          frame({ type: "response.output_item.done", output_index: 1, item: call }) +
          frame({
            type: "response.completed",
            response: { status: "completed", output: [{ ...reasoning, status: "completed" }, call] }
          })
      )
    const reasoningIndex = request.input.findIndex((item) => "type" in item && item.type === "reasoning")
    expect(reasoningIndex).toBeGreaterThan(0)
    expect(request.input[reasoningIndex]).toEqual(reasoning)
    expect(request.input[reasoningIndex + 1]).toMatchObject({
      type: "function_call",
      call_id: call.call_id,
      name: call.name,
      arguments: call.arguments
    })
    expect(request.input[reasoningIndex + 2]).toMatchObject({ type: "function_call_output", call_id: call.call_id })
    expect(lastToolResult(request)).toEqual({ revision: 0, schema: { types: [], relations: [] } })
    return answer("Your knowledge schema is empty at revision zero.")
  }
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          const input = { deliveryId: "11111111-1111-4111-8111-111111111111", text: "Inspect my knowledge." }
          yield* conversation.send(input)
          const reply = yield* waitForReply(conversation, input.deliveryId)
          expect(reply.state).toBe("Completed")
          expect(reply.text).toBe("Your knowledge schema is empty at revision zero.")
          expect((yield* conversation.page({ limit: 100 })).messages.map((message) => message.text)).toEqual([
            input.text,
            reply.text
          ])
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
    expect(calls).toBe(2)
  } finally {
    await database.close()
  }
})

it.each(["reasoning-text-call", "call-text"])(
  "replays %s in exact provider order while delivering the preamble before terminal tool admission",
  async (order) => {
    const database = await temporaryDatabase()
    const preamble = "I am checking your knowledge. "
    const reasoning = { type: "reasoning", id: "rs_order", summary: [], encrypted_content: "opaque-order-fixture" }
    const call = {
      type: "function_call",
      id: "fc_order",
      call_id: "call_order",
      name: "inspect_knowledge",
      arguments: "{}",
      status: "completed"
    }
    const message = {
      type: "message",
      id: "msg_order",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: preamble, annotations: [] }]
    }
    const output = order === "reasoning-text-call" ? [reasoning, message, call] : [call, message]
    let complete: (() => void) | undefined
    let inspections = 0
    let calls = 0
    const transport: ToolInferenceTransport = async (request) => {
      calls++
      if (calls === 1) {
        const early =
          frame({
            type: "response.output_item.added",
            item: { type: "reasoning", id: reasoning.id, summary: [], status: "in_progress" }
          }) +
          frame({ type: "response.output_item.done", item: reasoning }) +
          frame({ type: "response.output_item.added", item: { ...call, arguments: "", status: "in_progress" } }) +
          frame({ type: "response.function_call_arguments.delta", item_id: call.id, delta: "{}" }) +
          frame({ type: "response.function_call_arguments.done", item_id: call.id, arguments: "{}" }) +
          frame({ type: "response.output_item.done", item: call }) +
          frame({ type: "response.output_text.delta", delta: preamble })
        const textFrames = order === "reasoning-text-call" ? early : early.split("\n\n").slice(2).join("\n\n")
        return new Response(
          new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder()
              controller.enqueue(encoder.encode(textFrames))
              complete = () => {
                controller.enqueue(
                  encoder.encode(frame({ type: "response.completed", response: { status: "completed", output } }))
                )
                controller.close()
              }
            }
          })
        )
      }
      const expected =
        order === "reasoning-text-call"
          ? [
              reasoning,
              { role: "assistant", content: preamble },
              { type: "function_call", id: call.id, call_id: call.call_id, name: call.name, arguments: call.arguments }
            ]
          : [
              { type: "function_call", id: call.id, call_id: call.call_id, name: call.name, arguments: call.arguments },
              { role: "assistant", content: preamble }
            ]
      expect(request.input.slice(1, -1)).toEqual(expected)
      expect(lastToolResult(request)).toEqual({ revision: 0, schema: { types: [], relations: [] } })
      return answer("The schema is empty.")
    }
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const conversation = yield* Conversation
            const input = {
              deliveryId: "11111111-1111-4111-8111-111111111111",
              text: "Check my knowledge with a preamble."
            }
            yield* conversation.send(input)
            yield* Effect.gen(function* () {
              while ((yield* conversation.reply(input.deliveryId)).text !== preamble) yield* Effect.sleep("5 millis")
            }).pipe(Effect.timeout("2 seconds"))
            expect(inspections).toBe(0)
            expect(complete).toBeDefined()
            yield* Effect.sync(() => complete?.())
            const reply = yield* waitForReply(conversation, input.deliveryId)
            expect(reply.state).toBe("Completed")
            expect(reply.text).toBe(`${preamble}The schema is empty.`)
            expect(inspections).toBe(1)
          })
        ).pipe(
          Effect.provide(
            replyLayer(
              database.path,
              knowledgeAnswerLayer(transport, (durable) => ({
                ...durable,
                current: () =>
                  Effect.sync(() => {
                    inspections++
                  }).pipe(Effect.andThen(durable.current()))
              })),
              { answerProvider: "subscription", answerModel: "gpt-6.1-sol" }
            )
          )
        )
      )
      expect(calls).toBe(2)
    } finally {
      await database.close()
    }
  }
)
