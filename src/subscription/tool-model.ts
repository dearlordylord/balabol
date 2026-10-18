import { TokenUsage } from "../usage/index.ts"
import { Context, Schema } from "effect"
import type { Stream } from "effect"
import type { InferenceFailed } from "./inference-model.ts"
const maximumRequestCharacters = 1100000
const maximumIdentityCharacters = 256
const maximumInputItems = 64
const maximumTools = 16
const maximumReasoningBytes = 65536
const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximumRequestCharacters))
const identity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximumIdentityCharacters))
export const ReasoningItem = Schema.Struct({
  type: Schema.Literal("reasoning"),
  id: identity,
  summary: Schema.Array(Schema.Struct({ type: Schema.Literal("summary_text"), text: Schema.String })),
  encrypted_content: Schema.String.check(Schema.isMinLength(1))
})
export type ReasoningItem = typeof ReasoningItem.Type
export const FunctionCallInput = Schema.Struct({
  type: Schema.Literal("function_call"),
  id: Schema.optionalKey(identity),
  call_id: identity,
  name: identity,
  arguments: text
})
export const ToolReplay = Schema.Array(
  Schema.Union([
    ReasoningItem.check(
      Schema.makeFilter((item) => Buffer.byteLength(JSON.stringify(item), "utf8") <= maximumReasoningBytes)
    ),
    Schema.Struct({ role: Schema.Literal("assistant"), content: text }),
    Schema.Struct({ ...FunctionCallInput.fields, id: identity })
  ])
).check(
  Schema.isMaxLength(maximumInputItems),
  Schema.makeFilter((items) => JSON.stringify(items).length <= maximumRequestCharacters)
)
export type ToolReplay = typeof ToolReplay.Type
export const ToolInput = Schema.Union([
  ReasoningItem,
  Schema.Struct({ role: Schema.Literals(["user", "assistant"]), content: text }),
  FunctionCallInput,
  Schema.Struct({ type: Schema.Literal("function_call_output"), call_id: identity, output: text })
])
export type ToolInput = typeof ToolInput.Type
export const ToolDefinition = Schema.Struct({
  type: Schema.Literal("function"),
  name: identity,
  description: text,
  parameters: Schema.JsonObject,
  strict: Schema.Boolean
})
export type ToolDefinition = typeof ToolDefinition.Type
export const ToolInferenceRequest = Schema.Struct({
  model: Schema.Literal("gpt-6.1-sol"),
  instructions: text,
  input: Schema.Array(ToolInput).check(Schema.isMaxLength(maximumInputItems)),
  tools: Schema.Array(ToolDefinition).check(Schema.isMaxLength(maximumTools)),
  toolChoice: Schema.Literals(["auto", "none", "required"])
})
export type ToolInferenceRequest = typeof ToolInferenceRequest.Type
export const ToolInferenceEvent = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("Reasoning"), item: ReasoningItem }),
  Schema.Struct({ kind: Schema.Literal("Delta"), text: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("ToolCall"), id: identity, callId: identity, name: identity, arguments: text }),
  Schema.Struct({
    kind: Schema.Literal("Completed"),
    finishReason: Schema.Literals(["stop", "tool_calls"]),
    usage: Schema.optionalKey(TokenUsage),
    replay: Schema.optionalKey(ToolReplay)
  })
])
export type ToolInferenceEvent = typeof ToolInferenceEvent.Type
export class SubscriptionToolInference extends Context.Service<
  SubscriptionToolInference,
  { readonly generate: (request: ToolInferenceRequest) => Stream.Stream<ToolInferenceEvent, InferenceFailed> }
>()("balabol/subscription-tool-inference") {}
