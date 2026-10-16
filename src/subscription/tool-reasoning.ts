import { Schema } from "effect"
import { inferenceFailed } from "./inference-model.ts"
import { ReasoningItem } from "./tool-model.ts"
const maximumReasoningBytes = 65536
const maximumReasoningItems = 8
const Identity = Schema.Struct({ id: ReasoningItem.fields.id })
const Finished = Schema.Struct({ status: Schema.optionalKey(Schema.Literal("completed")) })
export const boundReasoning = (item: ReasoningItem): void => {
  if (Buffer.byteLength(JSON.stringify(item), "utf8") > maximumReasoningBytes) throw inferenceFailed("Limit")
}
const canonical = (raw: unknown): ReasoningItem => {
  Schema.decodeUnknownSync(Finished)(raw)
  const item = Schema.decodeUnknownSync(ReasoningItem)(raw)
  boundReasoning(item)
  return item
}
/** In-progress ciphertext is never replayable; only matching completed items can escape. */
export class ToolReasoning {
  private readonly started = new Set<string>()
  private readonly finished = new Map<string, ReasoningItem>()
  constructor(private readonly identities: Set<string>) {}
  add(raw: unknown): void {
    const { id } = Schema.decodeUnknownSync(Identity)(raw)
    if (this.identities.has(id)) throw inferenceFailed("Protocol")
    if (this.started.size >= maximumReasoningItems) throw inferenceFailed("Limit")
    this.identities.add(id)
    this.started.add(id)
  }
  done(raw: unknown): void {
    const item = canonical(raw)
    if (!this.started.has(item.id) || this.finished.has(item.id)) throw inferenceFailed("Protocol")
    this.finished.set(item.id, item)
  }
  terminal(raw: unknown): ReasoningItem {
    const item = canonical(raw)
    const previous = this.finished.get(item.id)
    if (previous === undefined || JSON.stringify(previous) !== JSON.stringify(item)) throw inferenceFailed("Protocol")
    return item
  }
  validateCount(count: number): void {
    if (count !== this.finished.size || count !== this.started.size) throw inferenceFailed("Protocol")
  }
}
