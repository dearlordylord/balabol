import { Schema } from "effect"
import { providerFailure } from "./inference-errors.ts"
import { inferenceFailed } from "./inference-model.ts"
import type { InferenceEvent } from "./inference-model.ts"
const maximumBodyBytes = 2097152
const maximumFrameBytes = 65536
const maximumOutputCharacters = 100000
const missingBoundary = -1
const separatorCharacters = 2
const dataPrefixCharacters = 5
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
  private pending = ""
  private bytes = 0
  private characters = 0
  private visible = false
  completed = false
  private readonly decoder = new TextDecoder("utf-8", { fatal: true })
  push(chunk: Uint8Array): readonly InferenceEvent[] {
    this.bytes += chunk.byteLength
    if (this.bytes > maximumBodyBytes) throw inferenceFailed("Limit")
    this.pending += this.decoder.decode(chunk, { stream: true })
    this.pending = this.pending.replace(/\r\n/g, "\n")
    const events: InferenceEvent[] = []
    let boundary = this.pending.indexOf("\n\n")
    while (boundary !== missingBoundary && !this.completed) {
      const frame = this.pending.slice(0, boundary)
      this.pending = this.pending.slice(boundary + separatorCharacters)
      if (Buffer.byteLength(frame) > maximumFrameBytes) throw inferenceFailed("Limit")
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(dataPrefixCharacters).trimStart())
        .join("\n")
      events.push(...this.frame(data))
      boundary = this.pending.indexOf("\n\n")
    }
    if (!this.completed && Buffer.byteLength(this.pending) > maximumFrameBytes) throw inferenceFailed("Limit")
    return events
  }
  finish(): void {
    if (this.completed) return
    if (this.pending.trimStart().startsWith("{")) {
      try {
        throw inferenceFailed(providerFailure(JSON.parse(this.pending), "json"))
      } catch (error) {
        if (error instanceof Error && error.name === "InferenceFailed") throw error
      }
    }
    throw inferenceFailed("Protocol")
  }
  private frame(data: string): readonly InferenceEvent[] {
    return !data || data === "[DONE]" ? [] : this.event(JSON.parse(data))
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
