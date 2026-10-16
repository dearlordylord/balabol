import { Effect, Layer, Schema, Stream } from "effect"
import { AiError, LanguageModel, Model, Tool, type Prompt } from "effect/ai"
import { SubscriptionToolInference, ToolInferenceRequest, type ToolInput } from "../subscription/index.ts"
import { SubscriptionParts } from "./subscription-parts.ts"
import { yieldedAnswerLayer } from "./yielded.ts"

const providerError = () =>
  AiError.make({
    module: "balabol/subscription",
    method: "streamText",
    reason: new AiError.UnknownError({ description: "Subscription structured answer failed" })
  })
const inputs = (prompt: Prompt.Prompt): ToolInput[] =>
  prompt.content.flatMap((message): ToolInput[] => {
    if (message.role === "system") return []
    return message.content.flatMap((part): ToolInput[] => {
      if (part.type === "text" && (message.role === "user" || message.role === "assistant"))
        return [{ role: message.role, content: part.text }]
      if (part.type === "tool-call")
        return [{ type: "function_call", call_id: part.id, name: part.name, arguments: JSON.stringify(part.params) }]
      if (part.type === "tool-result")
        return [{ type: "function_call_output", call_id: part.id, output: JSON.stringify(part.result) }]
      return []
    })
  })
const request = (options: LanguageModel.ProviderOptions) =>
  Schema.decodeUnknownEffect(ToolInferenceRequest)({
    model: "gpt-6.1-sol",
    instructions: options.prompt.content
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n"),
    input: inputs(options.prompt),
    tools: options.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: Tool.getDescription(tool) ?? "Explicit application tool",
      parameters: Tool.getJsonSchema(tool),
      strict: Tool.getStrictMode(tool) ?? true
    })),
    toolChoice:
      typeof options.toolChoice === "string"
        ? options.toolChoice
        : "mode" in options.toolChoice
          ? (options.toolChoice.mode ?? "auto")
          : "required"
  })

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
