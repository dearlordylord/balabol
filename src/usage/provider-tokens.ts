import { Option, Schema } from "effect"
import { TokenUsage } from "./contracts.ts"

const count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
const Reported = Schema.Struct({
  input_tokens: Schema.optionalKey(count),
  output_tokens: Schema.optionalKey(count),
  input_tokens_details: Schema.optionalKey(Schema.Struct({ cached_tokens: Schema.optionalKey(count) })),
  output_tokens_details: Schema.optionalKey(Schema.Struct({ reasoning_tokens: Schema.optionalKey(count) }))
})
/** Missing or malformed optional telemetry is unavailable, never invented zero. */
export const reportedTokens = (raw: unknown): TokenUsage | undefined => {
  const parsed = Schema.decodeUnknownOption(Reported)(raw)
  if (Option.isNone(parsed)) return undefined
  const value = parsed.value
  const tokens = {
    ...(value.input_tokens === undefined ? {} : { input: value.input_tokens }),
    ...(value.output_tokens === undefined ? {} : { output: value.output_tokens }),
    ...(value.input_tokens_details?.cached_tokens === undefined
      ? {}
      : { cachedInput: value.input_tokens_details.cached_tokens }),
    ...(value.output_tokens_details?.reasoning_tokens === undefined
      ? {}
      : { reasoningOutput: value.output_tokens_details.reasoning_tokens })
  }
  return Option.getOrUndefined(Schema.decodeUnknownOption(TokenUsage)(tokens))
}

const Terminal = Schema.Struct({
  response: Schema.optionalKey(Schema.Struct({ usage: Schema.optionalKey(Schema.Unknown) }))
})
export const responseTokens = (raw: unknown): TokenUsage | undefined => {
  const terminal = Schema.decodeUnknownOption(Terminal)(raw)
  return Option.isSome(terminal) ? reportedTokens(terminal.value.response?.usage) : undefined
}
