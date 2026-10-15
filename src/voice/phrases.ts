import { isScalarBoundary, validLanguageSpans } from "../language/index.ts"
import type { LanguageSpan } from "../language/index.ts"
const maximumPhrase = 800
const maximumQueued = 2
const maximumBuffered = maximumPhrase * maximumQueued
export interface Phrase {
  text: string
  language: string
}
const prefix = (text: string) => {
  let length = Math.min(text.length, maximumPhrase)
  if (!isScalarBoundary(text, length)) length -= 1
  return text.slice(0, length)
}
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
  let boundary = first.end
  for (const span of spans.slice(index + 1)) {
    if (span.start !== boundary || span.language !== first.language) break
    boundary = span.end
  }
  return { language: first.language, boundary }
}
export class Phrases {
  #source = ""
  #cursor = 0
  #offset = 0
  #buffer = ""
  #spans: readonly LanguageSpan[] = []
  #fallback = "en"
  append(text: string, spans: readonly LanguageSpan[] = [], fallback = "en") {
    if (!text.startsWith(this.#source) || !validLanguageSpans(text, spans)) return false
    this.#source = text
    this.#spans = spans
    this.#fallback = fallback
    return true
  }
  #stage(): void {
    let end = Math.min(this.#source.length, this.#cursor + maximumBuffered - this.#buffer.length)
    if (!isScalarBoundary(this.#source, end)) end -= 1
    this.#buffer += this.#source.slice(this.#cursor, end)
    this.#cursor = end
  }
  next(flush: boolean): Phrase | undefined {
    this.#stage()
    const run = languageRun(this.#spans, this.#offset, this.#cursor, this.#fallback)
    const available = this.#buffer.slice(0, run.boundary - this.#offset)
    const length = phraseLength(available, flush || available.length < this.#buffer.length)
    if (length === 0) return undefined
    const text = this.#buffer.slice(0, length).trim()
    this.#buffer = this.#buffer.slice(length)
    this.#offset += length
    return text.length === 0 ? this.next(flush) : { text, language: run.language }
  }
  get empty() {
    return this.#buffer.length === 0 && this.#cursor === this.#source.length
  }
}
