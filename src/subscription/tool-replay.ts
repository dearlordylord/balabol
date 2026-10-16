import { Schema } from "effect"
import { inferenceFailed } from "./inference-model.ts"
import { FunctionCallInput, ToolReplay } from "./tool-model.ts"
const Message = Schema.Struct({
  type: Schema.Literal("message"),
  role: Schema.Literal("assistant"),
  status: Schema.optionalKey(Schema.Literal("completed")),
  content: Schema.Array(Schema.Struct({ type: Schema.Literal("output_text"), text: Schema.String }))
})
const Kind = Schema.Struct({ type: Schema.String })
const TextItem = Schema.Struct({ role: Schema.Literal("assistant"), content: Schema.String })
const canonicalItem = (item: unknown): unknown => {
  const kind = Schema.decodeUnknownSync(Kind)(item).type
  if (kind === "message") {
    const message = Schema.decodeUnknownSync(Message)(item)
    return { role: "assistant", content: message.content.map((part) => part.text).join("") }
  }
  if (kind === "function_call") return Schema.decodeUnknownSync(FunctionCallInput)(item)
  return item
}
/** Terminal messages must account for every streamed character before their tool step can be replayed. */
export const completedReplay = (output: readonly unknown[], streamedText: string): ToolReplay => {
  const replay = Schema.decodeUnknownSync(ToolReplay)(output.map(canonicalItem))
  const text = replay
    .filter((item) => "role" in item)
    .map((item) => Schema.decodeUnknownSync(TextItem)(item).content)
    .join("")
  if (text !== streamedText) throw inferenceFailed("Protocol")
  return replay
}
