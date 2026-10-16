import { Effect, Layer, Redacted, Stream } from "effect"
import { Subscription, SubscriptionToolInference, subscriptionToolInferenceLayer } from "../src/subscription/index.ts"
export const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
export const reasoning = {
  type: "reasoning",
  id: "rs_1",
  summary: [{ type: "summary_text", text: "Inspect saved knowledge" }],
  encrypted_content: "opaque-fixture"
} as const
export const call = {
  type: "function_call",
  id: "fc_1",
  call_id: "call_1",
  name: "inspect_schema",
  arguments: "{}",
  status: "completed"
} as const
export const request = {
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
export const credentials = Layer.succeed(
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
export const started = (item: unknown) => frame({ type: "response.output_item.added", item })
export const done = (item: unknown) => frame({ type: "response.output_item.done", item })
export const terminal = (output: readonly unknown[]) =>
  frame({ type: "response.completed", response: { status: "completed", output } })
export const reasoningWire =
  started({ ...reasoning, status: "in_progress", encrypted_content: "partial" }) +
  done({ ...reasoning, status: "completed" })
export const argumentsWire =
  started({ ...call, arguments: "", status: "in_progress" }) +
  frame({ type: "response.function_call_arguments.delta", item_id: call.id, delta: "{}" }) +
  frame({ type: "response.function_call_arguments.done", item_id: call.id, arguments: "{}" })
export const callWire = argumentsWire + done(call)
export const collect = (wire: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const inference = yield* SubscriptionToolInference
      return yield* Stream.runCollect(inference.generate(request))
    }).pipe(
      Effect.provide(subscriptionToolInferenceLayer(async () => new Response(wire)).pipe(Layer.provide(credentials)))
    )
  )

export const invalidMessageWires = [
  ["unfinished registered message", started({ type: "message", id: "msg_pending" })],
  [
    "unknown indexed message",
    frame({
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "message", id: "msg_unknown", role: "assistant", content: [{ type: "output_text", text: "Saved" }] }
    })
  ],
  [
    "duplicate completed message",
    done({
      type: "message",
      id: "msg_duplicate",
      role: "assistant",
      content: [{ type: "output_text", text: "Saved" }]
    }) +
      done({
        type: "message",
        id: "msg_duplicate",
        role: "assistant",
        content: [{ type: "output_text", text: "Saved" }]
      })
  ],
  [
    "changed reasoning kind",
    started(reasoning) +
      done({ type: "message", id: reasoning.id, role: "assistant", content: [{ type: "output_text", text: "Saved" }] })
  ],
  [
    "missing registered message identity",
    frame({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_registered" } }) +
      frame({
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Saved" }] }
      })
  ]
] as const
