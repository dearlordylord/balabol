import { inferenceFailed } from "./inference-model.ts"
import { Effect, Layer, Schema, Stream } from "effect"
import type { Redacted } from "effect"
import { Subscription } from "./service.ts"
import { inferenceStream, responsesHttpTransport, safeFailure } from "./inference.ts"
import type { ToolInput } from "./tool-model.ts"
import { SubscriptionToolInference, ToolInferenceRequest } from "./tool-model.ts"
import { boundReasoning } from "./tool-reasoning.ts"
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
        include: ["reasoning.encrypted_content"],
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
  const identities = new Set<string>()
  for (const input of request.input) validateInput(input, calls, results, identities)
  if (calls.size !== results.size) throw inferenceFailed("Protocol")
  return request
}

function validateInput(
  input: ToolInput,
  calls: Map<string, string | undefined>,
  results: Set<string>,
  identities: Set<string>
) {
  if ("role" in input) return
  if (input.type === "reasoning") {
    boundReasoning(input)
    registerInputIdentity(input.id, identities)
    return
  }
  if (input.type === "function_call") {
    if (input.id !== undefined) registerInputIdentity(input.id, identities)
    if (calls.has(input.call_id)) throw inferenceFailed("Protocol")
    Schema.decodeUnknownSync(Schema.JsonObject)(JSON.parse(input.arguments))
    calls.set(input.call_id, input.id)
  } else {
    if (!calls.has(input.call_id) || results.has(input.call_id)) throw inferenceFailed("Protocol")
    results.add(input.call_id)
  }
}

function registerInputIdentity(id: string, identities: Set<string>) {
  if (identities.has(id)) throw inferenceFailed("Protocol")
  identities.add(id)
}
