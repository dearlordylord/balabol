import { Schema } from "effect"
import type { Response } from "effect/ai"
import { ReasoningItem, ToolReplay, type ToolInferenceEvent } from "../subscription/index.ts"

const maximumCalls = 8
const maximumReasoningItems = 8
/** Opaque reasoning and tool declarations are released only after the provider commits the whole model step. */
export class SubscriptionParts {
  completed = false
  private started = false
  private readonly committed: Response.StreamPartEncoded[] = []
  private readonly identities = new Map<string, string>()
  private readonly reasoningItems = new Map<string, ReasoningItem>()
  private text = ""
  private callCount = 0

  accept(event: ToolInferenceEvent): readonly Response.StreamPartEncoded[] {
    if (this.completed) throw new Error("Event after completion")
    if (event.kind === "Delta") return this.delta(event.text)
    if (event.kind === "ToolCall") {
      this.call(event)
      return []
    }
    if (event.kind === "Reasoning") {
      this.reasoning(event.item)
      return []
    }
    if ((event.finishReason === "tool_calls") !== this.callCount > 0) throw new Error("Invalid terminal reason")
    this.completed = true
    const parts: Response.StreamPartEncoded[] = this.started ? [{ type: "text-end", id: "answer" }] : []
    const committed = this.replay(event.replay)
    parts.push(...committed, {
      type: "finish",
      reason: event.finishReason === "stop" ? "stop" : "tool-calls",
      usage: { inputTokens: {}, outputTokens: {} }
    })
    return parts
  }

  private replay(raw: unknown): readonly Response.StreamPartEncoded[] {
    if (raw === undefined) return this.committed
    const replay = Schema.decodeUnknownSync(ToolReplay)(raw)
    const calls = replay.filter((item) => "type" in item && item.type === "function_call")
    if (calls.length !== this.callCount || new Set(calls.map((call) => call.call_id)).size !== calls.length)
      throw new Error("Replay call count or identity mismatch")
    this.validateReplayContent(replay)
    calls.forEach((call) => this.validateCall(call))
    let attached = false
    return this.committed.map((part) => {
      if (part.type !== "tool-call" || attached) return part
      attached = true
      return { ...part, metadata: { ...part.metadata, balabolSubscription: { replay } } }
    })
  }

  private validateCall(call: {
    readonly id: string
    readonly call_id: string
    readonly name: string
    readonly arguments: string
  }) {
    const native = this.committed.find((part) => part.type === "tool-call" && part.id === call.call_id)
    if (
      native?.type !== "tool-call" ||
      native.name !== call.name ||
      this.identities.get(call.call_id) !== call.id ||
      JSON.stringify(native.params) !== JSON.stringify(JSON.parse(call.arguments))
    )
      throw new Error("Replay call mismatch")
  }

  private validateReplayContent(replay: ToolReplay) {
    const reasoning = replay.filter((item) => "type" in item && item.type === "reasoning")
    if (
      reasoning.length !== this.reasoningItems.size ||
      new Set(reasoning.map((item) => item.id)).size !== reasoning.length
    )
      throw new Error("Replay reasoning count or identity mismatch")
    for (const item of reasoning)
      if (JSON.stringify(this.reasoningItems.get(item.id)) !== JSON.stringify(item))
        throw new Error("Replay reasoning mismatch")
    const text = replay.flatMap((item) => ("role" in item ? [item.content] : [])).join("")
    if (text !== this.text) throw new Error("Replay text mismatch")
  }

  private reasoning(raw: ReasoningItem) {
    const item = Schema.decodeUnknownSync(ReasoningItem)(raw)
    if (this.reasoningItems.has(item.id) || this.reasoningItems.size >= maximumReasoningItems)
      throw new Error("Invalid reasoning identity or limit")
    const id = `reasoning-${this.reasoningItems.size}`
    this.reasoningItems.set(item.id, item)
    this.committed.push(
      { type: "reasoning-start", id },
      { type: "reasoning-end", id, metadata: { balabolSubscription: { reasoningItem: item } } }
    )
  }

  private delta(text: string): readonly Response.StreamPartEncoded[] {
    this.text += text
    const parts: Response.StreamPartEncoded[] = []
    if (!this.started) {
      parts.push({ type: "text-start", id: "answer" })
      this.started = true
    }
    parts.push({ type: "text-delta", id: "answer", delta: text })
    return parts
  }

  private call(event: Extract<ToolInferenceEvent, { kind: "ToolCall" }>) {
    if (this.identities.has(event.callId) || this.callCount >= maximumCalls)
      throw new Error("Invalid tool identity or limit")
    this.identities.set(event.callId, event.id)
    this.callCount++
    this.committed.push({
      type: "tool-call",
      id: event.callId,
      name: event.name,
      params: Schema.decodeUnknownSync(Schema.JsonObject)(JSON.parse(event.arguments)),
      providerExecuted: false
    })
  }
}
