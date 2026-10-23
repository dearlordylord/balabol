import type { AnswerEvent } from "../answer-generation/index.ts"
import { AnswerFailed } from "../answer-generation/index.ts"
import type { LanguageSpan } from "../language/index.ts"
import { plainBlock } from "./plain-text-block.ts"
const maximumSourceCharacters = 100000
const insertedSpace = -1
const lastSpan = -1
export interface PlainTextState {
  readonly pending: string
  readonly spans: readonly LanguageSpan[]
  readonly preceding: string
  readonly lineStart: boolean
  readonly fence: string | null
  readonly sourceCharacters: number
}
export const initialPlainText: PlainTextState = {
  pending: "",
  spans: [],
  preceding: "",
  lineStart: true,
  fence: null,
  sourceCharacters: 0
}
const sliceSpans = (spans: readonly LanguageSpan[], start: number): readonly LanguageSpan[] =>
  spans
    .filter((span) => span.end > start)
    .map((span) => ({ ...span, start: Math.max(start, span.start) - start, end: span.end - start }))
/** Local builders are never stored in state or shared with the caller. */
const appendSpan = (mapped: LanguageSpan[], span: LanguageSpan): void => {
  const previous = mapped.at(lastSpan)
  if (previous?.language === span.language && previous.end === span.start)
    mapped[mapped.length - 1] = { ...previous, end: span.end }
  else mapped.push(span)
}
const maximumPendingSpans = 1000
const pendingSpans = (spans: readonly LanguageSpan[]) => {
  const merged: LanguageSpan[] = []
  for (const span of spans) appendSpan(merged, span)
  if (merged.length > maximumPendingSpans)
    throw new AnswerFailed({ message: "Provider annotations exceed the application limit" })
  return merged
}
const spanCursor = (spans: readonly LanguageSpan[], start: number, origin: number) => {
  let current = start
  while (origin >= (spans[current]?.end ?? Infinity)) current++
  return current
}
const mapSpans = (spans: readonly LanguageSpan[], origins: readonly number[]): readonly LanguageSpan[] => {
  const mapped: LanguageSpan[] = []
  let current = 0
  for (let index = 0; index < origins.length; index++) {
    const origin = origins[index] ?? insertedSpace
    if (origin < 0) continue
    current = spanCursor(spans, current, origin)
    const span = spans[current]
    if (span !== undefined && origin >= span.start)
      appendSpan(mapped, { language: span.language, start: index, end: index + 1 })
  }
  return mapped
}
const flush = (
  state: PlainTextState,
  final: boolean
): { readonly state: PlainTextState; readonly events: readonly AnswerEvent[] } => {
  let current = state
  const events: AnswerEvent[] = []
  while (current.pending.length > 0) {
    const result = plainBlock(current.pending, final, current.lineStart, current.fence, current.preceding)
    if (result.consumed === 0) break
    const text = result.origins.map((origin) => (origin < 0 ? " " : (current.pending[origin] ?? ""))).join("")
    if (text.length > 0) events.push({ kind: "Delta", text, languageSpans: mapSpans(current.spans, result.origins) })
    current = {
      ...current,
      pending: current.pending.slice(result.consumed),
      preceding: current.pending[result.consumed - 1] ?? current.preceding,
      spans: sliceSpans(current.spans, result.consumed),
      lineStart: current.pending[result.consumed - 1] === "\n",
      fence: result.fence
    }
  }
  return { state: current, events }
}
/** Conversation's sole model-text boundary: publication, durable memory and Voice all consume these exact deltas.
 * Cancellation/failure discard the unresolved suffix; only normal completion flushes literal unmatched syntax. */
export const normalizeAnswerEvent = (state: PlainTextState, event: AnswerEvent) => {
  if (event.kind === "Retry") return { state, events: [event] }
  if (event.kind === "Completed") {
    const result = flush(state, true)
    return { state: result.state, events: [...result.events, event] }
  }
  const sourceCharacters = state.sourceCharacters + event.text.length
  if (sourceCharacters > maximumSourceCharacters)
    throw new AnswerFailed({ message: "Provider output exceeds bounded valid text and annotations" })
  return flush(
    {
      ...state,
      sourceCharacters,
      pending: state.pending + event.text,
      spans: pendingSpans([
        ...state.spans,
        ...event.languageSpans.map((span) => ({
          ...span,
          start: span.start + state.pending.length,
          end: span.end + state.pending.length
        }))
      ])
    },
    false
  )
}
