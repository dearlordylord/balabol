import { expect, it } from "vitest"
import { SubscriptionParts } from "../src/answer-generation/subscription-parts.ts"

const reasoning = { type: "reasoning" as const, id: "rs_manifest", summary: [], encrypted_content: "opaque-fixture" }
const call = {
  type: "function_call" as const,
  id: "fc_manifest",
  call_id: "call_manifest",
  name: "inspect_knowledge",
  arguments: "{}"
}
const ready = () => {
  const parts = new SubscriptionParts()
  parts.accept({ kind: "Reasoning", item: reasoning })
  parts.accept({ kind: "Delta", text: "Checking. " })
  parts.accept({ kind: "ToolCall", id: call.id, callId: call.call_id, name: call.name, arguments: call.arguments })
  return parts
}
const message = { role: "assistant" as const, content: "Checking. " }
it.each([
  { label: "unknown call identity", replay: [reasoning, message, { ...call, call_id: "unknown" }] },
  { label: "altered wire item identity", replay: [reasoning, message, { ...call, id: "fc_forged" }] },
  { label: "altered call name", replay: [reasoning, message, { ...call, name: "query_knowledge" }] },
  { label: "altered call arguments", replay: [reasoning, message, { ...call, arguments: '{"unexpected":true}' }] },
  { label: "missing reasoning", replay: [message, call] },
  { label: "altered reasoning", replay: [{ ...reasoning, encrypted_content: "different" }, message, call] },
  { label: "altered streamed text", replay: [reasoning, { ...message, content: "Different. " }, call] },
  { label: "duplicate reasoning", replay: [reasoning, reasoning, message, call] },
  { label: "duplicate calls", replay: [reasoning, message, call, call] }
])("rejects a committed replay manifest with $label before exposing native calls", ({ replay }) => {
  expect(() => ready().accept({ kind: "Completed", finishReason: "tool_calls", replay })).toThrow()
})
it("rejects duplicate call identities even when the manifest length matches two admitted calls", () => {
  const parts = ready()
  parts.accept({ kind: "ToolCall", id: "fc_second", callId: "call_second", name: call.name, arguments: "{}" })
  expect(() =>
    parts.accept({ kind: "Completed", finishReason: "tool_calls", replay: [reasoning, message, call, call] })
  ).toThrow("identity mismatch")
})
it("rejects duplicate reasoning identities even when the manifest length matches admitted reasoning", () => {
  const parts = ready()
  parts.accept({ kind: "Reasoning", item: { ...reasoning, id: "rs_second" } })
  expect(() =>
    parts.accept({ kind: "Completed", finishReason: "tool_calls", replay: [reasoning, reasoning, message, call] })
  ).toThrow("identity mismatch")
})

it("releases complete native fallback reasoning and calls without a replay manifest", () => {
  const parts = ready().accept({ kind: "Completed", finishReason: "tool_calls" })
  expect(parts.map((part) => part.type)).toEqual([
    "text-end",
    "reasoning-start",
    "reasoning-end",
    "tool-call",
    "finish"
  ])
})
it("rejects every event after a completed model step", () => {
  const parts = new SubscriptionParts()
  parts.accept({ kind: "Delta", text: "Done." })
  parts.accept({ kind: "Completed", finishReason: "stop" })
  expect(() => parts.accept({ kind: "Delta", text: "Late." })).toThrow("Event after completion")
})
it("rejects a tool-calls terminal reason without an admitted call", () => {
  const parts = new SubscriptionParts()
  parts.accept({ kind: "Reasoning", item: reasoning })
  expect(() => parts.accept({ kind: "Completed", finishReason: "tool_calls" })).toThrow("Invalid terminal reason")
})
it("rejects a stop terminal reason while admitted calls remain pending", () => {
  expect(() => ready().accept({ kind: "Completed", finishReason: "stop" })).toThrow("Invalid terminal reason")
})
