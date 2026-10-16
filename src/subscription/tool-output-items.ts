import { Schema } from "effect"
import { inferenceFailed } from "./inference-model.ts"
import { FunctionCallInput, ReasoningItem } from "./tool-model.ts"
const maximumOutputItems = 64
const beforeFirstItem = -1
const DoneStatus = Schema.Struct({ status: Schema.optionalKey(Schema.Literal("completed")) })
const Item = Schema.Struct({
  type: Schema.Literals(["function_call", "message", "reasoning"]),
  id: Schema.optionalKey(ReasoningItem.fields.id)
})
const Indexed = Schema.Struct({ output_index: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))) })
const Reference = Schema.Struct({ item_id: ReasoningItem.fields.id, ...Indexed.fields })
const Message = Schema.Struct({
  type: Schema.Literal("message"),
  id: Schema.optionalKey(ReasoningItem.fields.id),
  role: Schema.Literal("assistant"),
  content: Schema.Array(Schema.Struct({ type: Schema.Literal("output_text"), text: Schema.String }))
})
const normalized = (raw: unknown): string => {
  const kind = Schema.decodeUnknownSync(Item)(raw).type
  if (kind === "reasoning") return JSON.stringify(Schema.decodeUnknownSync(ReasoningItem)(raw))
  if (kind === "function_call") return JSON.stringify(Schema.decodeUnknownSync(FunctionCallInput)(raw))
  return JSON.stringify(Schema.decodeUnknownSync(Message)(raw))
}
type Tracked = {
  readonly kind: (typeof Item.Type)["type"]
  readonly id: string | undefined
  readonly index: number
  readonly indexed: boolean
  done: unknown
}
/** Some subscription terminals omit output; item-done records remain private until successful completion. */
export class ToolOutputItems {
  private readonly items: Tracked[] = []
  start(raw: unknown, envelope: unknown): void {
    const item = Schema.decodeUnknownSync(Item)(raw)
    const index = Schema.decodeUnknownSync(Indexed)(envelope).output_index
    if (index !== undefined && index !== this.items.length) throw inferenceFailed("Protocol")
    if (item.id !== undefined && this.items.some((previous) => previous.id === item.id))
      throw inferenceFailed("Protocol")
    if (this.items.length >= maximumOutputItems) throw inferenceFailed("Limit")
    this.items.push({
      kind: item.type,
      id: item.id,
      index: this.items.length,
      indexed: index !== undefined,
      done: undefined
    })
  }
  done(raw: unknown, envelope: unknown): void {
    Schema.decodeUnknownSync(DoneStatus)(raw)
    const item = Schema.decodeUnknownSync(Item)(raw)
    const supplied = Schema.decodeUnknownSync(Indexed)(envelope).output_index
    let previous = this.find(item.id, supplied)
    if (previous === undefined) {
      if (item.type !== "message" || supplied !== undefined) throw inferenceFailed("Protocol")
      this.start(raw, envelope)
      previous = this.items.at(beforeFirstItem)
    }
    if (previous === undefined || previous.done !== undefined || previous.kind !== item.type)
      throw inferenceFailed("Protocol")
    this.checkIndex(previous, supplied)
    if (previous.id !== item.id) throw inferenceFailed("Protocol")
    previous.done = raw
  }
  reference(envelope: unknown): void {
    const reference = Schema.decodeUnknownSync(Reference)(envelope)
    const previous = this.find(reference.item_id, reference.output_index)
    if (previous === undefined) throw inferenceFailed("Protocol")
    this.checkIndex(previous, reference.output_index)
  }
  output(aggregate: readonly unknown[]): readonly unknown[] {
    if (aggregate.length === 0) {
      if (this.items.some((item) => item.done === undefined)) throw inferenceFailed("Protocol")
      return this.items.map((item) => item.done)
    }
    if (this.items.some((item) => item.done === undefined)) throw inferenceFailed("Protocol")
    this.crosscheck(aggregate)
    return aggregate
  }
  private find(id: string | undefined, index: number | undefined): Tracked | undefined {
    if (id !== undefined) return this.items.find((item) => item.id === id)
    return index === undefined ? undefined : this.items[index]
  }
  private checkIndex(item: Tracked, supplied: number | undefined): void {
    if (supplied !== undefined && supplied !== item.index) throw inferenceFailed("Protocol")
  }
  private checkCompleted(item: Tracked, raw: unknown): void {
    if (item.done === undefined || normalized(item.done) !== normalized(raw)) throw inferenceFailed("Protocol")
  }
  private crosscheck(aggregate: readonly unknown[]): void {
    let precedingIndex = beforeFirstItem
    const found = new Set<Tracked>()
    for (const raw of aggregate) {
      const item = Schema.decodeUnknownSync(Item)(raw)
      const previous = this.find(item.id, undefined)
      if (previous === undefined) continue
      if (found.has(previous)) throw inferenceFailed("Protocol")
      if (previous.indexed && previous.index <= precedingIndex) throw inferenceFailed("Protocol")
      this.checkCompleted(previous, raw)
      precedingIndex = previous.index
      found.add(previous)
    }
    if (this.items.some((item) => item.id !== undefined && !found.has(item))) throw inferenceFailed("Protocol")
  }
}
