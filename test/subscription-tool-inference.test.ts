import { it } from "@effect/vitest"
import { Effect, Fiber, Layer, Redacted, Stream } from "effect"
import { expect } from "vitest"
import {
  Subscription,
  SubscriptionToolInference,
  SubscriptionInference,
  subscriptionInferenceLayer,
  toolInferenceHttpTransport,
  subscriptionToolInferenceLayer
} from "../src/subscription/index.ts"
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
const call = {
  type: "function_call",
  id: "fc_1",
  call_id: "call_1",
  name: "inspect_schema",
  arguments: "{}",
  status: "completed"
} as const
const request = {
  model: "gpt-6.1-sol",
  instructions: "Explicit",
  input: [{ role: "user", content: "Inspect" }],
  tools: [
    {
      type: "function",
      name: "inspect_schema",
      description: "Read schema",
      parameters: { type: "object", properties: {} },
      strict: true
    }
  ],
  toolChoice: "auto"
} as const
const credentials = Layer.succeed(
  Subscription,
  Subscription.of({
    begin: () => Effect.die("unused"),
    complete: () => Effect.die("unused"),
    status: () => Effect.succeed({ kind: "Connected", expiresAt: 999999 }),
    accessToken: () => Effect.succeed(Redacted.make("fixture")),
    models: () => Effect.succeed(["gpt-6.1-sol"]),
    disconnect: () => Effect.succeed({ revocation: "NotNeeded" })
  })
)
const collect = (wire: string) =>
  Effect.gen(function* () {
    const inference = yield* SubscriptionToolInference
    return yield* Stream.runCollect(inference.generate(request))
  }).pipe(
    Effect.provide(subscriptionToolInferenceLayer(async () => new Response(wire)).pipe(Layer.provide(credentials)))
  )
it.effect("releases completed structured calls only after a successful terminal", () =>
  collect(
    frame({
      type: "response.output_item.added",
      output_index: 0,
      item: { ...call, arguments: "", status: "in_progress" }
    }) +
      frame({ type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: "{}" }) +
      frame({ type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 0, arguments: "{}" }) +
      frame({ type: "response.output_item.done", output_index: 0, item: call }) +
      frame({ type: "response.completed", response: { status: "completed", output: [call] } })
  ).pipe(
    Effect.map((events) =>
      expect(events).toEqual([
        { kind: "ToolCall", id: "fc_1", callId: "call_1", name: "inspect_schema", arguments: "{}" },
        { kind: "Completed", finishReason: "tool_calls" }
      ])
    )
  )
)
for (const [name, wire] of [
  ["unknown tool", frame({ type: "response.output_item.added", item: { ...call, name: "shell", arguments: "" } })],
  [
    "partial arguments",
    frame({ type: "response.output_item.added", item: { ...call, arguments: "" } }) +
      frame({ type: "response.completed", response: { status: "completed", output: [call] } })
  ],
  ["hidden call", frame({ type: "response.completed", response: { status: "completed", output: [call] } })],
  ["incomplete", frame({ type: "response.incomplete" })],
  ["empty", frame({ type: "response.completed", response: { status: "completed", output: [] } })]
])
  it.effect(`rejects ${name} without successful tool execution`, () =>
    collect(wire ?? "").pipe(
      Effect.flip,
      Effect.map((error) => expect(error.reason).toBe(name === "incomplete" ? "Incomplete" : "Protocol"))
    )
  )
it.effect("failed terminal discards complete tool data rather than emitting a call", () =>
  collect(
    frame({ type: "response.output_item.added", item: { ...call, arguments: "" } }) +
      frame({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "{}" }) +
      frame({ type: "response.function_call_arguments.done", item_id: "fc_1", arguments: "{}" }) +
      frame({ type: "response.output_item.done", item: call }) +
      frame({ type: "response.failed", response: { error: { code: "invalid_token" } } })
  ).pipe(
    Effect.flip,
    Effect.map((error) => expect(error.reason).toBe("Authentication"))
  )
)
it.effect("rejects duplicate call identity", () =>
  collect(
    frame({ type: "response.output_item.added", item: { ...call, arguments: "" } }) +
      frame({ type: "response.output_item.added", item: { ...call, id: "fc_2", arguments: "" } })
  ).pipe(
    Effect.flip,
    Effect.map((error) => expect(error.reason).toBe("Protocol"))
  )
)
it.effect("sends explicit full replay with function call and actual result without provider state", () =>
  Effect.tryPromise(async () => {
    const replay = {
      ...request,
      input: [...request.input, call, { type: "function_call_output", call_id: "call_1", output: '{"tables":[]}' }]
    } as const
    const transport = toolInferenceHttpTransport(async (url, init) => {
      expect(url).toBe("https://api.openai.com/v1/responses")
      expect(JSON.parse(typeof init?.body === "string" ? init.body : "null")).toEqual({
        model: "gpt-6.1-sol",
        instructions: "Explicit",
        input: replay.input,
        tools: request.tools,
        tool_choice: "auto",
        store: false,
        stream: true
      })
      expect(init?.headers).toMatchObject({ Authorization: "Bearer fixture" })
      return new Response("")
    })
    await transport(replay, Redacted.make("fixture"), new AbortController().signal)
  })
)
it.effect("continuation accepts omitted provider item identity and rejects unmatched results before transport", () =>
  Effect.gen(function* () {
    const inference = yield* SubscriptionToolInference
    const events = yield* Stream.runCollect(
      inference.generate({
        ...request,
        input: [
          ...request.input,
          { type: "function_call", call_id: "call_1", name: "inspect_schema", arguments: "{}" },
          { type: "function_call_output", call_id: "call_1", output: '{"tables":[]}' }
        ]
      })
    )
    expect(events).toEqual([
      { kind: "Delta", text: "Empty schema" },
      { kind: "Completed", finishReason: "stop" }
    ])
    const error = yield* Stream.runCollect(
      inference.generate({ ...request, input: [{ type: "function_call_output", call_id: "missing", output: "{}" }] })
    ).pipe(Effect.flip)
    expect(error.reason).toBe("Protocol")
  }).pipe(
    Effect.provide(
      subscriptionToolInferenceLayer(
        async () =>
          new Response(
            frame({ type: "response.output_text.delta", delta: "Empty schema" }) +
              frame({ type: "response.completed", response: { status: "completed", output: [{ type: "message" }] } })
          )
      ).pipe(Layer.provide(credentials))
    )
  )
)
it.effect("cancellation discards buffered tool data and releases the reader", () =>
  Effect.gen(function* () {
    let started = () => {}
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    let cancelled = false
    const bytes = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(frame({ type: "response.output_item.added", item: { ...call, arguments: "" } }))
        )
      },
      pull() {
        started()
      },
      cancel() {
        cancelled = true
      }
    })
    yield* Effect.gen(function* () {
      const inference = yield* SubscriptionToolInference
      const running = yield* Effect.forkChild(Stream.runCollect(inference.generate(request)))
      yield* Effect.promise(() => entered)
      yield* Fiber.interrupt(running)
      expect(cancelled).toBe(true)
      expect(bytes.locked).toBe(false)
    }).pipe(
      Effect.provide(subscriptionToolInferenceLayer(async () => new Response(bytes)).pipe(Layer.provide(credentials)))
    )
  })
)

it.effect("each execution of the same text stream gets fresh protocol state", () =>
  Effect.gen(function* () {
    const inference = yield* SubscriptionInference
    const stream = inference.generate({ model: "gpt-6.1-sol", instructions: "Explicit", input: "Inspect" })
    const expected = [{ kind: "Delta", text: "Fresh" }, { kind: "Completed" }]
    expect(yield* Stream.runCollect(stream)).toEqual(expected)
    expect(yield* Stream.runCollect(stream)).toEqual(expected)
  }).pipe(
    Effect.provide(
      subscriptionInferenceLayer(
        async () =>
          new Response(
            frame({ type: "response.output_text.delta", delta: "Fresh" }) +
              frame({ type: "response.completed", response: { status: "completed" } })
          )
      ).pipe(Layer.provide(credentials))
    )
  )
)
const argumentsReady = (item: typeof call) =>
  frame({ type: "response.output_item.added", item: { ...item, arguments: "", status: "in_progress" } }) +
  frame({ type: "response.function_call_arguments.delta", item_id: item.id, delta: "{}" }) +
  frame({ type: "response.function_call_arguments.done", item_id: item.id, arguments: "{}" })
for (const [name, wire] of [
  ["item completion before argument completion", frame({ type: "response.output_item.done", item: call })],
  [
    "changed completed arguments",
    argumentsReady(call) +
      frame({ type: "response.output_item.done", item: { ...call, arguments: '{"unexpected":true}' } })
  ],
  [
    "duplicate completed item",
    argumentsReady(call) +
      frame({ type: "response.output_item.done", item: call }) +
      frame({ type: "response.output_item.done", item: call })
  ],
  [
    "changed tool name",
    argumentsReady(call) + frame({ type: "response.output_item.done", item: { ...call, name: "other_tool" } })
  ],
  [
    "changed call identity",
    argumentsReady(call) + frame({ type: "response.output_item.done", item: { ...call, call_id: "other_call" } })
  ]
])
  it.effect(`rejects ${name} before exposing a structured call`, () =>
    collect(wire ?? "").pipe(
      Effect.flip,
      Effect.map((error) => expect(error.reason).toBe("Protocol"))
    )
  )
for (const [name, input] of [
  ["reused call identity", [call, { ...call, id: "fc_2" }]],
  ["reused provider item identity", [call, { ...call, call_id: "call_2" }]],
  [
    "duplicate result",
    [
      call,
      { type: "function_call_output", call_id: "call_1", output: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "{}" }
    ]
  ]
] as const)
  it.effect(`rejects replay with ${name} before sending private input`, () =>
    Effect.gen(function* () {
      const inference = yield* SubscriptionToolInference
      const error = yield* Stream.runCollect(inference.generate({ ...request, input })).pipe(Effect.flip)
      expect(error.reason).toBe("Protocol")
    }).pipe(
      Effect.provide(
        subscriptionToolInferenceLayer(async () => {
          throw new Error("Invalid replay reached transport")
        }).pipe(Layer.provide(credentials))
      )
    )
  )
