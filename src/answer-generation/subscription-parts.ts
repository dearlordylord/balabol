import { Schema } from "effect"
import type { Response } from "effect/ai"
import type { ToolInferenceEvent } from "../subscription/index.ts"

const maximumCalls = 8
/** Tool declarations are released only after the provider commits the whole model step. */
export class SubscriptionParts {
  completed = false
  private started = false
  private readonly calls: Response.StreamPartEncoded[] = []
  private readonly identities = new Set<string>()

  accept(event: ToolInferenceEvent): readonly Response.StreamPartEncoded[] {
    if (this.completed) throw new Error("Event after completion")
    if (event.kind === "Delta") return this.delta(event.text)
    if (event.kind === "ToolCall") {
      this.call(event)
      return []
    }
    if ((event.finishReason === "tool_calls") !== this.calls.length > 0) throw new Error("Invalid terminal reason")
    this.completed = true
    const parts: Response.StreamPartEncoded[] = this.started ? [{ type: "text-end", id: "answer" }] : []
    parts.push(...this.calls, {
      type: "finish",
      reason: event.finishReason === "stop" ? "stop" : "tool-calls",
      usage: { inputTokens: {}, outputTokens: {} }
    })
    return parts
  }

  private delta(text: string): readonly Response.StreamPartEncoded[] {
    const parts: Response.StreamPartEncoded[] = []
    if (!this.started) {
      parts.push({ type: "text-start", id: "answer" })
      this.started = true
    }
    parts.push({ type: "text-delta", id: "answer", delta: text })
    return parts
  }

  private call(event: Extract<ToolInferenceEvent, { kind: "ToolCall" }>) {
    if (this.identities.has(event.callId) || this.calls.length >= maximumCalls)
      throw new Error("Invalid tool identity or limit")
    this.identities.add(event.callId)
    this.calls.push({
      type: "tool-call",
      id: event.callId,
      name: event.name,
      params: Schema.decodeUnknownSync(Schema.JsonObject)(JSON.parse(event.arguments)),
      providerExecuted: false
    })
  }
}
