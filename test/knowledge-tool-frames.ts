import type { ToolInferenceRequest } from "../src/subscription/index.ts"
export const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
export const tool = (name: string, parameters: unknown, id: string): Response => {
  const args = JSON.stringify(parameters)
  const call = { type: "function_call", id: `item-${id}`, call_id: id, name, arguments: args, status: "completed" }
  return new Response(
    frame({ type: "response.output_item.added", item: { ...call, arguments: "", status: "in_progress" } }) +
      frame({ type: "response.function_call_arguments.delta", item_id: call.id, delta: args }) +
      frame({ type: "response.function_call_arguments.done", item_id: call.id, arguments: args }) +
      frame({ type: "response.output_item.done", item: call }) +
      frame({ type: "response.completed", response: { status: "completed", output: [call] } })
  )
}
export const answer = (text: string): Response =>
  new Response(
    frame({ type: "response.output_text.delta", delta: text }) +
      frame({ type: "response.completed", response: { status: "completed", output: [] } })
  )
export const lastToolResult = (request: ToolInferenceRequest): unknown => {
  const item = request.input.findLast((entry) => "type" in entry && entry.type === "function_call_output")
  if (item === undefined || !("output" in item)) throw new Error("Missing tool result")
  return JSON.parse(item.output)
}
