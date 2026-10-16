import { Effect, Layer, Redacted, Stream } from "effect"
import { expect, it } from "vitest"
import {
  SubscriptionToolInference,
  subscriptionToolInferenceLayer,
  toolInferenceHttpTransport
} from "../src/subscription/index.ts"
import {
  frame,
  invalidMessageWires,
  reasoning,
  call,
  request,
  credentials,
  started,
  done,
  terminal,
  reasoningWire,
  argumentsWire,
  callWire,
  collect
} from "./subscription-reasoning-fixture.ts"

it("releases canonical completed reasoning and calls in terminal output order", async () => {
  expect(await collect(reasoningWire + callWire + terminal([reasoning, call]))).toEqual([
    { kind: "Reasoning", item: reasoning },
    { kind: "ToolCall", id: call.id, callId: call.call_id, name: call.name, arguments: "{}" },
    {
      kind: "Completed",
      finishReason: "tool_calls",
      replay: [
        reasoning,
        { type: "function_call", id: call.id, call_id: call.call_id, name: call.name, arguments: call.arguments }
      ]
    }
  ])
})
for (const [label, wire] of [
  ["missing lifecycle", callWire + terminal([reasoning, call])],
  ["missing terminal", reasoningWire + callWire],
  ["changed ciphertext", reasoningWire + callWire + terminal([{ ...reasoning, encrypted_content: "changed" }, call])],
  [
    "missing ciphertext",
    started(reasoning) + done({ ...reasoning, encrypted_content: null }) + callWire + terminal([reasoning, call])
  ],
  [
    "incomplete status",
    started(reasoning) + done({ ...reasoning, status: "incomplete" }) + callWire + terminal([reasoning, call])
  ],
  ["duplicate done", reasoningWire + done(reasoning) + callWire + terminal([reasoning, call])],
  ["duplicate terminal item", reasoningWire + callWire + terminal([reasoning, reasoning, call])],
  [
    "shared call identity",
    started({ ...reasoning, id: call.id }) +
      done({ ...reasoning, id: call.id }) +
      callWire +
      terminal([{ ...reasoning, id: call.id }, call])
  ],
  ["reasoning without visible output", reasoningWire + terminal([reasoning])]
] as const)
  it(`rejects ${label} without releasing executable calls`, async () => {
    await expect(collect(wire)).rejects.toMatchObject({ reason: "Protocol" })
  })

it("requests encrypted reasoning and replays it independently from correlated call results", async () => {
  const replay = {
    ...request,
    input: [
      ...request.input,
      reasoning,
      { type: "function_call", id: call.id, call_id: call.call_id, name: call.name, arguments: call.arguments },
      { type: "function_call_output", call_id: call.call_id, output: "{}" }
    ]
  } as const
  const transport = toolInferenceHttpTransport(async (_url, init) => {
    const body: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "null")
    expect(body).toMatchObject({ include: ["reasoning.encrypted_content"], store: false, input: replay.input })
    return new Response("")
  })
  await transport(replay, Redacted.make("fixture"), new AbortController().signal)
  const events = await Effect.runPromise(
    Effect.gen(function* () {
      const inference = yield* SubscriptionToolInference
      return yield* Stream.runCollect(inference.generate(replay))
    }).pipe(
      Effect.provide(
        subscriptionToolInferenceLayer(
          async () => new Response(frame({ type: "response.output_text.delta", delta: "Saved" }) + terminal([]))
        ).pipe(Layer.provide(credentials))
      )
    )
  )
  expect(events).toEqual([
    { kind: "Delta", text: "Saved" },
    { kind: "Completed", finishReason: "stop" }
  ])
})

it("rejects a ninth reasoning item before terminal publication", async () => {
  const items = Array.from({ length: 9 }, (_, index) => ({ ...reasoning, id: `rs_${index}` }))
  await expect(
    collect(items.map((item) => started(item) + done(item)).join("") + callWire + terminal([...items, call]))
  ).rejects.toMatchObject({ reason: "Limit" })
})

it("accepts a 64-KiB opaque replay item and rejects one byte more or duplicated item identities", async () => {
  const base = { ...reasoning, encrypted_content: "" }
  const exact = { ...base, encrypted_content: "x".repeat(65536 - Buffer.byteLength(JSON.stringify(base))) }
  expect(Buffer.byteLength(JSON.stringify(exact))).toBe(65536)
  const application = subscriptionToolInferenceLayer(
    async () => new Response(frame({ type: "response.output_text.delta", delta: "Saved" }) + terminal([]))
  ).pipe(Layer.provide(credentials))
  await Effect.runPromise(
    Effect.gen(function* () {
      const inference = yield* SubscriptionToolInference
      expect(
        yield* Stream.runCollect(inference.generate({ ...request, input: [...request.input, exact] }))
      ).toMatchObject([{ kind: "Delta", text: "Saved" }, { kind: "Completed" }])
      const oversized = yield* Stream.runCollect(
        inference.generate({ ...request, input: [{ ...exact, encrypted_content: `${exact.encrypted_content}x` }] })
      ).pipe(Effect.result)
      expect(oversized).toMatchObject({ _tag: "Failure", failure: { reason: "Limit" } })
      const duplicated = yield* Stream.runCollect(
        inference.generate({ ...request, input: [reasoning, reasoning] })
      ).pipe(Effect.result)
      expect(duplicated).toMatchObject({ _tag: "Failure", failure: { reason: "Protocol" } })
      const shared = yield* Stream.runCollect(
        inference.generate({
          ...request,
          input: [
            reasoning,
            { type: "function_call", id: reasoning.id, call_id: call.call_id, name: call.name, arguments: "{}" },
            { type: "function_call_output", call_id: call.call_id, output: "{}" }
          ]
        })
      ).pipe(Effect.result)
      expect(shared).toMatchObject({ _tag: "Failure", failure: { reason: "Protocol" } })
    }).pipe(Effect.provide(application))
  )
})

it("does not publish buffered reasoning or calls when a fragmented response ends before its terminal", async () => {
  const seen: string[] = []
  const wire = reasoningWire + callWire
  const chunks = new TextEncoder().encode(wire)
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < chunks.length; offset += 7) controller.enqueue(chunks.slice(offset, offset + 7))
        controller.close()
      }
    })
  )
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const inference = yield* SubscriptionToolInference
      return yield* inference.generate(request).pipe(
        Stream.tap((event) =>
          Effect.sync(() => {
            seen.push(event.kind)
          })
        ),
        Stream.runCollect,
        Effect.result
      )
    }).pipe(Effect.provide(subscriptionToolInferenceLayer(async () => response).pipe(Layer.provide(credentials))))
  )
  expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "Protocol" } })
  expect(seen).toEqual([])
})

it("retains reasoning on a text-only terminal without classifying it as a tool-call finish", async () => {
  expect(
    await collect(
      reasoningWire +
        frame({ type: "response.output_text.delta", delta: "Saved" }) +
        terminal([reasoning, { type: "message", role: "assistant", content: [{ type: "output_text", text: "Saved" }] }])
    )
  ).toEqual([
    { kind: "Delta", text: "Saved" },
    { kind: "Reasoning", item: reasoning },
    { kind: "Completed", finishReason: "stop" }
  ])
})

it("retains the full ordered assistant output when reasoning and text precede a tool call", async () => {
  const message = {
    type: "message",
    id: "msg_1",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "I will inspect that.", annotations: [] }]
  }
  const events = await collect(
    reasoningWire +
      frame({ type: "response.output_text.delta", delta: "I will inspect that." }) +
      callWire +
      terminal([reasoning, message, call])
  )
  expect(events.at(-1)).toEqual({
    kind: "Completed",
    finishReason: "tool_calls",
    replay: [
      reasoning,
      { role: "assistant", content: "I will inspect that." },
      { type: "function_call", id: call.id, call_id: call.call_id, name: call.name, arguments: call.arguments }
    ]
  })
})

it("retains text following a call in the provider output order", async () => {
  const message = { type: "message", role: "assistant", content: [{ type: "output_text", text: "One moment." }] }
  const events = await collect(
    callWire + frame({ type: "response.output_text.delta", delta: "One moment." }) + terminal([call, message])
  )
  expect(events.at(-1)).toMatchObject({
    replay: [
      { type: "function_call", id: call.id },
      { role: "assistant", content: "One moment." }
    ]
  })
})
for (const [label, output] of [
  ["missing text item", [call]],
  [
    "changed terminal text",
    [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Different" }] }, call]
  ],
  [
    "non-assistant message",
    [{ type: "message", role: "user", content: [{ type: "output_text", text: "Preamble" }] }, call]
  ],
  [
    "incomplete message",
    [
      {
        type: "message",
        role: "assistant",
        status: "incomplete",
        content: [{ type: "output_text", text: "Preamble" }]
      },
      call
    ]
  ],
  [
    "non-text content",
    [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "Preamble" }] }, call]
  ]
] as const)
  it(`rejects a tool step with ${label}`, async () => {
    await expect(
      collect(frame({ type: "response.output_text.delta", delta: "Preamble" }) + callWire + terminal(output))
    ).rejects.toMatchObject({ reason: "Protocol" })
  })

it("accepts the qualified subscription wire shape with validated done items and an empty terminal aggregate", async () => {
  const wire =
    frame({ type: "response.created", response: { status: "in_progress", output: [] } }) +
    frame({
      type: "response.output_item.added",
      output_index: 0,
      item: { ...call, arguments: "", status: "in_progress" }
    }) +
    frame({ type: "response.function_call_arguments.delta", item_id: call.id, output_index: 0, delta: "{}" }) +
    frame({ type: "response.metadata" }) +
    frame({ type: "response.function_call_arguments.done", item_id: call.id, output_index: 0, arguments: "{}" }) +
    frame({ type: "response.output_item.done", output_index: 0, item: call }) +
    terminal([])
  expect((await collect(wire)).at(-1)).toEqual({
    kind: "Completed",
    finishReason: "tool_calls",
    replay: [{ type: "function_call", id: call.id, call_id: call.call_id, name: call.name, arguments: call.arguments }]
  })
})

it("reconstructs ordered reasoning, completed preamble and calls from a sparse terminal", async () => {
  const message = {
    type: "message",
    id: "msg_1",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Preamble" }]
  }
  const wire =
    frame({
      type: "response.output_item.added",
      output_index: 0,
      item: { ...reasoning, encrypted_content: "partial" }
    }) +
    frame({ type: "response.output_item.done", output_index: 0, item: reasoning }) +
    frame({
      type: "response.output_item.added",
      output_index: 1,
      item: { ...message, status: "in_progress", content: [] }
    }) +
    frame({ type: "response.output_text.delta", delta: "Preamble" }) +
    frame({ type: "response.output_item.done", output_index: 1, item: message }) +
    frame({
      type: "response.output_item.added",
      output_index: 2,
      item: { ...call, arguments: "", status: "in_progress" }
    }) +
    frame({ type: "response.function_call_arguments.delta", item_id: call.id, output_index: 2, delta: "{}" }) +
    frame({ type: "response.function_call_arguments.done", item_id: call.id, output_index: 2, arguments: "{}" }) +
    frame({ type: "response.output_item.done", output_index: 2, item: call }) +
    terminal([])
  expect((await collect(wire)).at(-1)).toMatchObject({
    replay: [reasoning, { role: "assistant", content: "Preamble" }, { type: "function_call", id: call.id }]
  })
})
for (const [label, wire] of [
  ["missing done", started({ ...call, arguments: "" }) + terminal([])],
  ["changed done identity", argumentsWire + done({ ...call, id: "fc_other" }) + terminal([])],
  ["incomplete done status", argumentsWire + done({ ...call, status: "incomplete" }) + terminal([])],
  [
    "changed done index",
    frame({ type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } }) +
      frame({ type: "response.function_call_arguments.delta", item_id: call.id, delta: "{}" }) +
      frame({ type: "response.function_call_arguments.done", item_id: call.id, arguments: "{}" }) +
      frame({ type: "response.output_item.done", output_index: 1, item: call }) +
      terminal([])
  ],
  [
    "out-of-order added index",
    frame({ type: "response.output_item.added", output_index: 1, item: { ...call, arguments: "" } }) + terminal([])
  ],
  [
    "duplicate done index",
    callWire + frame({ type: "response.output_item.done", output_index: 0, item: call }) + terminal([])
  ],
  [
    "changed argument index",
    frame({ type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } }) +
      frame({ type: "response.function_call_arguments.delta", item_id: call.id, output_index: 1, delta: "{}" }) +
      terminal([])
  ]
] as const)
  it(`rejects a sparse terminal with ${label}`, async () => {
    await expect(collect(wire)).rejects.toMatchObject({ reason: "Protocol" })
  })

it("allows more than eight prior reasoning items within the bounded whole-request replay", async () => {
  const input = Array.from({ length: 9 }, (_, index) => ({ ...reasoning, id: `prior_${index}` }))
  const events = await Effect.runPromise(
    Effect.gen(function* () {
      const inference = yield* SubscriptionToolInference
      return yield* Stream.runCollect(inference.generate({ ...request, input }))
    }).pipe(
      Effect.provide(
        subscriptionToolInferenceLayer(
          async () => new Response(frame({ type: "response.output_text.delta", delta: "Saved" }) + terminal([]))
        ).pipe(Layer.provide(credentials))
      )
    )
  )
  expect(events).toEqual([
    { kind: "Delta", text: "Saved" },
    { kind: "Completed", finishReason: "stop" }
  ])
})

it("rejects a nonempty terminal aggregate that reverses registered output indexes", async () => {
  const wire =
    frame({ type: "response.output_item.added", output_index: 0, item: reasoning }) +
    frame({ type: "response.output_item.done", output_index: 0, item: reasoning }) +
    frame({ type: "response.output_item.added", output_index: 1, item: { ...call, arguments: "" } }) +
    frame({ type: "response.function_call_arguments.delta", item_id: call.id, output_index: 1, delta: "{}" }) +
    frame({ type: "response.function_call_arguments.done", item_id: call.id, output_index: 1, arguments: "{}" }) +
    frame({ type: "response.output_item.done", output_index: 1, item: call }) +
    terminal([call, reasoning])
  await expect(collect(wire)).rejects.toMatchObject({ reason: "Protocol" })
})

for (const sparse of [false, true])
  it(`rejects contradictory final text with ${sparse ? "sparse" : "full"} terminal output`, async () => {
    const message = {
      type: "message",
      id: "msg_stop",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "NOT SAVED" }]
    }
    const wire =
      started({ ...message, status: "in_progress", content: [] }) +
      frame({ type: "response.output_text.delta", delta: "SAVED" }) +
      done(message) +
      terminal(sparse ? [] : [message])
    await expect(collect(wire)).rejects.toMatchObject({ reason: "Protocol" })
  })

it("accepts a self-contained unindexed completed message without an added lifecycle event", async () => {
  const message = {
    type: "message",
    id: "msg_self",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Saved" }]
  }
  expect(
    await collect(frame({ type: "response.output_text.delta", delta: "Saved" }) + done(message) + terminal([]))
  ).toEqual([
    { kind: "Delta", text: "Saved" },
    { kind: "Completed", finishReason: "stop" }
  ])
})
for (const [label, wire] of invalidMessageWires)
  it(`rejects ${label} before committing a final text response`, async () => {
    await expect(
      collect(frame({ type: "response.output_text.delta", delta: "Saved" }) + wire + terminal([]))
    ).rejects.toMatchObject({ reason: "Protocol" })
  })
