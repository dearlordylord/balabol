import { InferenceFrames } from "./inference-frames.ts"
import { Schema } from "effect"
import { providerFailure } from "./inference-errors.ts"
import { inferenceFailed } from "./inference-model.ts"
import type { InferenceEvent } from "./inference-model.ts"
const maximumOutputCharacters = 100000
const Event = Schema.Struct({ type: Schema.String })
const Delta = Schema.Struct({ delta: Schema.String })
const OutputItem = Schema.Struct({ type: Schema.Literals(["message", "reasoning"]) })
const Completed = Schema.Struct({
  response: Schema.Struct({ status: Schema.Literal("completed"), output: Schema.optionalKey(Schema.Array(OutputItem)) })
})
const Item = Schema.Struct({ item: Schema.Struct({ type: Schema.Literals(["message", "reasoning"]) }) })
const decode = Schema.decodeUnknownSync
/** Per-request parser state; no retained context or text survives into another request. */
export class ResponseParser {
  private characters = 0
  private visible = false
  completed = false
  private readonly frames = new InferenceFrames(
    (raw) => this.event(raw),
    () => this.completed
  )
  push(chunk: Uint8Array) {
    return this.frames.push(chunk)
  }
  finish() {
    this.frames.finish()
  }
  private event(raw: unknown): readonly InferenceEvent[] {
    const event = decode(Event)(raw)
    if (event.type === "response.output_text.delta") return this.delta(decode(Delta)(raw).delta)
    if (event.type === "response.completed") {
      decode(Completed)(raw)
      if (!this.visible) throw inferenceFailed("Protocol")
      this.completed = true
      return [{ kind: "Completed" }]
    }
    return this.other(event.type, raw)
  }
  private other(type: string, raw: unknown): readonly InferenceEvent[] {
    if (type === "response.failed" || type === "error") throw inferenceFailed(providerFailure(raw, type))
    if (type === "response.incomplete") throw inferenceFailed("Incomplete")
    if (["response.output_item.added", "response.output_item.done"].includes(type)) decode(Item)(raw)
    if (type.includes("tool") || type.includes("function_call")) throw inferenceFailed("Protocol")
    return []
  }
  private delta(text: string): readonly InferenceEvent[] {
    this.characters += text.length
    if (this.characters > maximumOutputCharacters) throw inferenceFailed("Limit")
    this.visible ||= text.trim().length > 0
    return text.length === 0 ? [] : [{ kind: "Delta", text }]
  }
}
