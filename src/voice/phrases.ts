import { isScalarBoundary, validLanguageSpans } from "../language/index.ts"
import type { LanguageSpan } from "../language/index.ts"
const maximumPhrase = 800
const maximumQueued = 2
const maximumBuffered = maximumPhrase * maximumQueued
export interface Phrase {
  text: string
  language: string
}
const scalarEnd = (text: string, maximum: number): number => {
  const length = Math.min(text.length, maximum)
  return isScalarBoundary(text, length) ? length : length - 1
}
const prefix = (text: string) => text.slice(0, scalarEnd(text, maximumPhrase))
const phraseLength = (buffer: string, flush: boolean) => {
  const candidate = prefix(buffer)
  const end = candidate.search(/[.!?\n。！？]/u)
  if (end >= 0) return end + 1
  if (buffer.length >= maximumPhrase) return candidate.lastIndexOf(" ") + 1 || candidate.length
  return flush ? buffer.length : 0
}
const languageRun = (spans: readonly LanguageSpan[], start: number, end: number, fallback: string) => {
  const index = spans.findIndex((span) => span.end > start)
  const first = spans[index]
  if (first === undefined) return { language: fallback, boundary: end }
  if (first.start > start) return { language: fallback, boundary: Math.min(end, first.start) }
  const boundary = spans
    .slice(index + 1)
    .reduce(
      (run, span) =>
        run.open && span.start === run.end && span.language === first.language
          ? { open: true, end: span.end }
          : { ...run, open: false },
      { open: true, end: first.end }
    ).end
  return { language: first.language, boundary }
}
export interface PhraseState {
  readonly source: string
  readonly cursor: number
  readonly offset: number
  readonly buffer: string
  readonly spans: readonly LanguageSpan[]
  readonly fallback: string
}
export const initialPhrases = (): PhraseState => ({
  source: "",
  cursor: 0,
  offset: 0,
  buffer: "",
  spans: [],
  fallback: "en"
})
export const appendPhrases = (
  state: PhraseState,
  text: string,
  spans: readonly LanguageSpan[] = [],
  fallback = "en"
): { readonly kind: "Accepted"; readonly state: PhraseState } | { readonly kind: "Rejected" } =>
  !text.startsWith(state.source) || !validLanguageSpans(text, spans)
    ? { kind: "Rejected" }
    : { kind: "Accepted", state: { ...state, source: text, spans, fallback } }
const stage = (state: PhraseState): PhraseState => {
  const end = scalarEnd(state.source, state.cursor + maximumBuffered - state.buffer.length)
  return { ...state, buffer: state.buffer + state.source.slice(state.cursor, end), cursor: end }
}
export const takePhrase = (
  state: PhraseState,
  flush: boolean
): { readonly state: PhraseState; readonly phrase: Phrase | null } => {
  const staged = stage(state)
  const run = languageRun(staged.spans, staged.offset, staged.cursor, staged.fallback)
  const available = staged.buffer.slice(0, run.boundary - staged.offset)
  const length = phraseLength(available, flush || available.length < staged.buffer.length)
  if (length === 0) return { state: staged, phrase: null }
  const text = staged.buffer.slice(0, length).trim()
  const next = { ...staged, buffer: staged.buffer.slice(length), offset: staged.offset + length }
  return text.length === 0 ? takePhrase(next, flush) : { state: next, phrase: { text, language: run.language } }
}
export const phrasesEmpty = (state: PhraseState): boolean =>
  state.buffer.length === 0 && state.cursor === state.source.length
