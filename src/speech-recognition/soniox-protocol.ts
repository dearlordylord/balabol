import { Schema } from "effect"
import { LanguageTag, type LanguageSpan } from "../language/index.ts"
import { RecognitionFailed } from "./provider.ts"
const maximumText = 100000
const maximumTokens = 10000
const maximumErrorType = 200
const maximumSpans = 1000
const lastOffset = -1
const billingStatus = 402
const Token = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(maximumText)),
  is_final: Schema.Boolean,
  language: Schema.optionalKey(LanguageTag)
})
export const SonioxPacket = Schema.Struct({
  tokens: Schema.optionalKey(Schema.Array(Token).check(Schema.isMaxLength(maximumTokens))),
  finished: Schema.optionalKey(Schema.Boolean),
  error_code: Schema.optionalKey(Schema.Int),
  error_type: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(maximumErrorType)))
})
export interface SonioxTranscript {
  readonly text: string
  readonly spans: readonly LanguageSpan[]
}
export const emptySonioxTranscript: SonioxTranscript = { text: "", spans: [] }
export const sonioxFailure = (message: string) => new RecognitionFailed({ reason: "Result", message })
const appendSpans = (state: SonioxTranscript, token: typeof Token.Type, text: string) => {
  if (token.language === undefined || token.text.length === 0) return state.spans
  const last = state.spans.at(lastOffset)
  const span = { start: state.text.length, end: text.length, language: token.language }
  return last?.language === token.language && last.end === span.start
    ? [...state.spans.slice(0, lastOffset), { ...last, end: span.end }]
    : [...state.spans, span]
}
const append = (state: SonioxTranscript, token: typeof Token.Type, languages: readonly string[]): SonioxTranscript => {
  if (token.text === "<end>" || token.text === "<fin>") return state
  if (token.language !== undefined && !languages.includes(token.language))
    throw sonioxFailure("Soniox returned a language outside the configured set")
  const text = state.text + token.text
  if (text.length > maximumText) throw sonioxFailure("Soniox transcript exceeded its text limit")
  const spans = appendSpans(state, token, text)
  if (spans.length > maximumSpans) throw sonioxFailure("Soniox transcript exceeded its language-span limit")
  return { text, spans }
}
/** Final tokens append once; non-final tokens replace the current hypothesis. */
export const reduceSonioxPacket = (state: SonioxTranscript, raw: unknown, languages: readonly string[]) => {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 1024 * 1024)
    throw sonioxFailure("Invalid or oversized Soniox message")
  const packet = Schema.decodeUnknownSync(SonioxPacket)(JSON.parse(raw))
  if (packet.error_code !== undefined)
    throw sonioxFailure(
      packet.error_code === billingStatus
        ? "Soniox billing unavailable: check balance and project or organization budget (HTTP 402)"
        : `Soniox rejected recognition (HTTP ${packet.error_code})`
    )
  const tokens = packet.tokens ?? []
  const committed = tokens
    .filter((token) => token.is_final)
    .reduce((next, token) => append(next, token, languages), state)
  const provisional = tokens
    .filter((token) => !token.is_final)
    .reduce((next, token) => append(next, token, languages), committed)
  if (packet.finished && provisional.text !== committed.text)
    throw sonioxFailure("Soniox finished with uncommitted transcript tokens")
  return { committed, provisional, finished: packet.finished === true }
}
