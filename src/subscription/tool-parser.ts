import { Schema } from "effect"
import { InferenceFrames } from "./inference-frames.ts"
import { inferenceFailed } from "./inference-model.ts"
import { providerFailure } from "./inference-errors.ts"
import { ToolInferenceEvent } from "./tool-model.ts"
import type { ToolInferenceRequest } from "./tool-model.ts"
const maximumCalls = 8
const maximumOutputCharacters = 100000
const decode = Schema.decodeUnknownSync
const Event = Schema.Struct({ type: Schema.String })
const Item = Schema.Struct({ type: Schema.Literals(["function_call", "message", "reasoning"]) })
const Call = Schema.Struct({
  type: Schema.Literal("function_call"),
  id: Schema.String,
  call_id: Schema.String,
  name: Schema.String,
  arguments: Schema.String,
  status: Schema.Literal("completed")
})
const ItemEvent = Schema.Struct({ item: Schema.Unknown })
const Argument = Schema.Struct({ item_id: Schema.String, arguments: Schema.String })
const ArgumentDelta = Schema.Struct({ item_id: Schema.String, delta: Schema.String })
const Completed = Schema.Struct({
  response: Schema.Struct({ status: Schema.Literal("completed"), output: Schema.Array(Schema.Unknown) })
})
/** Calls stay private until the provider commits an identical completed output. */
export class ToolResponseParser {
  private completed = false
  private characters = 0
  private visible = false
  private readonly identities = new Map<string, { readonly name: string; readonly call_id: string }>()
  private readonly calls = new Map<string, typeof Call.Type>()
  private readonly arguments = new Map<string, string>()
  private readonly doneArguments = new Set<string>()
  private readonly frames = new InferenceFrames(
    (raw) => this.event(raw),
    () => this.completed
  )
  constructor(private readonly request: ToolInferenceRequest) {}
  push(chunk: Uint8Array) {
    return this.frames.push(chunk)
  }
  finish() {
    this.frames.finish()
  }
  private event(raw: unknown): readonly ToolInferenceEvent[] {
    const { type } = decode(Event)(raw)
    if (type === "response.output_text.delta")
      return this.delta(decode(Schema.Struct({ delta: Schema.String }))(raw).delta)
    if (type === "response.completed") return this.complete(decode(Completed)(raw).response.output)
    if (type === "response.failed" || type === "error") throw inferenceFailed(providerFailure(raw, type))
    if (type === "response.incomplete") throw inferenceFailed("Incomplete")
    return this.other(type, raw)
  }
  private other(type: string, raw: unknown): readonly ToolInferenceEvent[] {
    if (type === "response.function_call_arguments.delta") {
      const event = decode(ArgumentDelta)(raw)
      this.append(event.item_id, event.delta)
      return []
    }
    if (type === "response.function_call_arguments.done") {
      const event = decode(Argument)(raw)
      if (this.arguments.get(event.item_id) !== event.arguments || this.doneArguments.has(event.item_id))
        throw inferenceFailed("Protocol")
      this.doneArguments.add(event.item_id)
      return []
    }
    return this.itemEvent(type, raw)
  }
  private itemEvent(type: string, raw: unknown): readonly ToolInferenceEvent[] {
    if (type === "response.output_item.done") {
      const item = decode(ItemEvent)(raw).item
      if (decode(Item)(item).type === "function_call") this.addCall(decode(Call)(item))
      return []
    }
    if (type === "response.output_item.added") {
      const item = decode(ItemEvent)(raw).item
      if (decode(Item)(item).type === "function_call") this.addIdentity(item)
      return []
    }
    if (type.includes("tool") || type.includes("function_call")) throw inferenceFailed("Protocol")
    return []
  }
  private addIdentity(raw: unknown) {
    const item = decode(
      Schema.Struct({ id: Schema.String, name: Schema.String, call_id: Schema.String, arguments: Schema.Literal("") })
    )(raw)
    if (!this.request.tools.some((tool) => tool.name === item.name) || this.request.toolChoice === "none")
      throw inferenceFailed("Protocol")
    if (this.arguments.has(item.id) || this.arguments.size >= maximumCalls) throw inferenceFailed("Limit")
    if ([...this.identities.values()].some((previous) => previous.call_id === item.call_id))
      throw inferenceFailed("Protocol")
    this.identities.set(item.id, item)
    this.arguments.set(item.id, "")
  }
  private append(id: string, delta: string) {
    const previous = this.arguments.get(id)
    if (previous === undefined || this.doneArguments.has(id)) throw inferenceFailed("Protocol")
    this.bound(delta.length)
    this.arguments.set(id, previous + delta)
  }
  private addCall(call: typeof Call.Type) {
    if (!this.doneArguments.has(call.id) || this.arguments.get(call.id) !== call.arguments || this.calls.has(call.id))
      throw inferenceFailed("Protocol")
    // addIdentity already enforces unique call IDs; completion must match that registered identity.
    const identity = this.identities.get(call.id)
    if (identity?.name !== call.name || identity.call_id !== call.call_id) throw inferenceFailed("Protocol")
    decode(Schema.JsonObject)(JSON.parse(call.arguments))
    this.calls.set(call.id, call)
  }
  private complete(output: readonly unknown[]): readonly ToolInferenceEvent[] {
    const calls = output.filter((item) => decode(Item)(item).type === "function_call").map((item) => decode(Call)(item))
    if (calls.length !== this.calls.size || calls.length !== this.arguments.size) throw inferenceFailed("Protocol")
    if (new Set(calls.map((call) => call.id)).size !== calls.length) throw inferenceFailed("Protocol")
    const events = calls.map((call) => this.callEvent(call))
    if (!this.visible && events.length === 0) throw inferenceFailed("Protocol")
    this.completed = true
    return [...events, { kind: "Completed", finishReason: events.length === 0 ? "stop" : "tool_calls" }]
  }
  private callEvent(call: typeof Call.Type): ToolInferenceEvent {
    const previous = this.calls.get(call.id)
    if (previous === undefined || JSON.stringify(previous) !== JSON.stringify(call)) throw inferenceFailed("Protocol")
    return decode(ToolInferenceEvent)({
      kind: "ToolCall",
      id: call.id,
      callId: call.call_id,
      name: call.name,
      arguments: call.arguments
    })
  }
  private delta(text: string): readonly ToolInferenceEvent[] {
    this.bound(text.length)
    this.visible ||= text.trim().length > 0
    return text.length ? [{ kind: "Delta", text }] : []
  }
  private bound(length: number) {
    this.characters += length
    if (this.characters > maximumOutputCharacters) throw inferenceFailed("Limit")
  }
}
