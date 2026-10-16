import { inferenceFailed } from "./inference-model.ts"
import { Effect, Layer, Schema, Stream } from "effect"
import type { Redacted } from "effect"
import { Subscription } from "./service.ts"
import { inferenceStream, responsesHttpTransport, safeFailure } from "./inference.ts"
import type { ToolInput } from "./tool-model.ts"
import { SubscriptionToolInference, ToolInferenceRequest } from "./tool-model.ts"
import { ToolResponseParser } from "./tool-parser.ts"
export type ToolInferenceTransport = (
  request: ToolInferenceRequest,
  token: Redacted.Redacted<string>,
  signal: AbortSignal
) => Promise<Response>
export function toolInferenceHttpTransport(fetcher: typeof fetch = fetch): ToolInferenceTransport {
  return function requestToolInference(request, token, signal) {
    return responsesHttpTransport(
      {
        model: request.model,
        instructions: request.instructions,
        input: request.input,
        tools: request.tools,
        tool_choice: request.toolChoice,
        store: false,
        stream: true
      },
      token,
      signal,
      fetcher
    )
  }
}
export const subscriptionToolInferenceLayer = (transport: ToolInferenceTransport = toolInferenceHttpTransport()) =>
  Layer.effect(
    SubscriptionToolInference,
    Effect.gen(function* () {
      const subscription = yield* Subscription
      return SubscriptionToolInference.of({
        generate: (raw) =>
          Stream.unwrap(
            Effect.try({
              try: () => validateRequest(Schema.decodeUnknownSync(ToolInferenceRequest)(raw)),
              catch: safeFailure
            }).pipe(
              Effect.map((request) =>
                inferenceStream(
                  request,
                  ToolInferenceRequest,
                  transport,
                  subscription,
                  () => new ToolResponseParser(request)
                )
              )
            )
          )
      })
    })
  )

const maximumRequestCharacters = 1100000
function validateRequest(request: ToolInferenceRequest) {
  if (JSON.stringify(request).length > maximumRequestCharacters) throw inferenceFailed("Limit")
  if (new Set(request.tools.map((tool) => tool.name)).size !== request.tools.length) throw inferenceFailed("Protocol")
  const calls = new Map<string, string | undefined>()
  const results = new Set<string>()
  for (const input of request.input) validateInput(input, calls, results)
  if (calls.size !== results.size) throw inferenceFailed("Protocol")
  return request
}

function validateInput(input: ToolInput, calls: Map<string, string | undefined>, results: Set<string>) {
  if ("role" in input) return
  if (input.type === "function_call") {
    if (calls.has(input.call_id) || (input.id !== undefined && [...calls.values()].includes(input.id)))
      throw inferenceFailed("Protocol")
    Schema.decodeUnknownSync(Schema.JsonObject)(JSON.parse(input.arguments))
    calls.set(input.call_id, input.id)
  } else {
    if (!calls.has(input.call_id) || results.has(input.call_id)) throw inferenceFailed("Protocol")
    results.add(input.call_id)
  }
}
