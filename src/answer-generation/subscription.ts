import { Effect, Layer, Schema, Stream } from "effect"
import { AiError, LanguageModel, Model, Tool, type Prompt } from "effect/ai"
import {
  SubscriptionToolInference,
  ToolInferenceRequest,
  ReasoningItem,
  ToolReplay,
  type ToolInput
} from "../subscription/index.ts"
import { SubscriptionParts } from "./subscription-parts.ts"
import { yieldedAnswerLayer } from "./yielded.ts"

const providerError = () =>
  AiError.make({
    module: "balabol/subscription",
    method: "streamText",
    reason: new AiError.UnknownError({ description: "Subscription structured answer failed" })
  })
export const subscriptionPromptInputs = (prompt: Prompt.Prompt): ToolInput[] =>
  prompt.content.flatMap((message): ToolInput[] => {
    if (message.role === "system") return []
    if (message.role === "assistant") {
      const carrier = message.content.find(
        (part) => part.type === "tool-call" && part.options["balabolSubscription"] !== undefined
      )
      if (carrier !== undefined)
        return Schema.decodeUnknownSync(Schema.Struct({ replay: ToolReplay }))(
          carrier.options["balabolSubscription"]
        ).replay.slice()
    }
    return message.content.flatMap((part): ToolInput[] => {
      if (part.type === "text" && (message.role === "user" || message.role === "assistant"))
        return [{ role: message.role, content: part.text }]
      if (part.type === "reasoning")
        return [
          Schema.decodeUnknownSync(Schema.Struct({ reasoningItem: ReasoningItem }))(part.options["balabolSubscription"])
            .reasoningItem
        ]
      if (part.type === "tool-call")
        return [{ type: "function_call", call_id: part.id, name: part.name, arguments: JSON.stringify(part.params) }]
      if (part.type === "tool-result")
        return [{ type: "function_call_output", call_id: part.id, output: JSON.stringify(part.result) }]
      throw new Error("Unsupported subscription prompt content")
    })
  })
// Effect's empty structural object exports a non-null constraint that OpenAI rejects.
const parameters = (tool: Tool.Any) => {
  const ast = tool.parametersSchema.ast
  return ast._tag === "Objects" && ast.propertySignatures.length === 0 && ast.indexSignatures.length === 0
    ? { type: "object", properties: {}, additionalProperties: false }
    : Tool.getJsonSchema(tool)
}
const request = (options: LanguageModel.ProviderOptions) =>
  Effect.try({
    try: () => ({
      model: "gpt-6.1-sol",
      instructions: options.prompt.content
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n"),
      input: subscriptionPromptInputs(options.prompt),
      tools: options.tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: Tool.getDescription(tool) ?? "Explicit application tool",
        parameters: parameters(tool),
        strict: Tool.getStrictMode(tool) ?? true
      })),
      toolChoice:
        typeof options.toolChoice === "string"
          ? options.toolChoice
          : "mode" in options.toolChoice
            ? (options.toolChoice.mode ?? "auto")
            : "required"
    }),
    catch: providerError
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ToolInferenceRequest)))

const subscriptionModel = (inference: typeof SubscriptionToolInference.Service) =>
  Model.make(
    "balabol-subscription",
    "gpt-6.1-sol",
    Layer.effect(
      LanguageModel.LanguageModel,
      LanguageModel.make({
        generateText: () => Effect.fail(providerError()),
        streamText: (options) =>
          Stream.unwrap(
            request(options).pipe(
              Effect.mapError(providerError),
              Effect.map((value) => {
                const parts = new SubscriptionParts()
                return inference.generate(value).pipe(
                  Stream.mapEffect((event) => Effect.try({ try: () => parts.accept(event), catch: providerError })),
                  Stream.flatMap(Stream.fromIterable),
                  Stream.concat(
                    Stream.unwrap(Effect.sync(() => (parts.completed ? Stream.empty : Stream.fail(providerError()))))
                  ),
                  Stream.mapError(providerError)
                )
              })
            )
          )
      })
    )
  )

export const subscriptionAnswerLayer = (languages: readonly string[] = ["ru", "fr", "en", "ja"]) =>
  Layer.unwrap(
    Effect.map(SubscriptionToolInference, (inference) => yieldedAnswerLayer(subscriptionModel(inference), languages))
  )
