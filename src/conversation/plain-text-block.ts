import { inlineOrigins } from "./plain-text-inline.ts"
export interface PlainBlock {
  readonly fence: string | null
  readonly origins: readonly number[]
  readonly consumed: number
}
const origins = (start: number, end: number) => Array.from({ length: end - start }, (_, index) => start + index)
const fenceMarker = /^ {0,3}(`{3,}|~{3,})([^\n]*)\n?$/u
const prefix = /^ {0,3}(?:#{1,6}[\t ]+|(?:[-+*]|\d+[.)])[\t ]+|>[\t ]+)/u
const ambiguousPrefix = /^ {0,3}(?:#{1,6}|[-+*>]|\d+[.)]?|`{1,2}|~{1,2})?$/u
const openingFence = /^ {0,3}(?:`{3,}|~{3,})/u
const closingCandidate = /^ {0,3}(?:`+|~+)[\t ]*$/u
const parsedFence = (text: string) => {
  const match = fenceMarker.exec(text)
  const marker = match?.[1]
  return marker === undefined ? undefined : { marker, trailer: match?.[2] ?? "" }
}
const closesFence = (text: string, fence: string) => {
  const closing = parsedFence(text)
  if (closing === undefined) return false
  return (
    closing.marker.startsWith(fence.slice(0, 1)) &&
    closing.marker.length >= fence.length &&
    closing.trailer.trim() === ""
  )
}
const literalBlock = (text: string, fence: string, complete: boolean): PlainBlock => {
  const consumed = !complete && /[\uD800-\uDBFF]$/u.test(text) ? text.length - 1 : text.length
  return { fence, origins: origins(0, consumed), consumed }
}
const fencedLine = (text: string, fence: string, complete: boolean): PlainBlock => {
  if (!complete && closingCandidate.test(text)) return { fence, origins: [], consumed: 0 }
  if (closesFence(text, fence)) return { fence: null, origins: [], consumed: text.length }
  return literalBlock(text, fence, complete)
}
/** Fenced bodies are literal; inline ambiguity may cross newlines, but ordinary lines retain block boundaries. */
export const plainBlock = (
  text: string,
  final: boolean,
  lineStart: boolean,
  fence: string | null,
  preceding: string
): PlainBlock => {
  const newline = text.indexOf("\n")
  const line = newline < 0 ? text : text.slice(0, newline + 1)
  const complete = newline >= 0 || final
  if (fence !== null) return lineStart ? fencedLine(line, fence, complete) : literalBlock(line, fence, complete)
  if (!lineStart) return { fence, ...inlineOrigins(text, final, 0, preceding) }
  return ordinaryBlock(text, line, complete, final)
}
const headingBlock = (line: string, complete: boolean, start: number): PlainBlock => {
  if (!complete) return { fence: null, origins: [], consumed: 0 }
  const closing = /[\t ]+(#+)[\t ]*(?=\n?$)/u.exec(line)
  const closeStart = closing === null ? line.length : closing.index + closing[0].indexOf("#")
  const result = inlineOrigins(line.slice(start), true)
  return {
    fence: null,
    consumed: line.length,
    origins: result.origins
      .map((origin) => (origin < 0 ? origin : origin + start))
      .filter((origin) => origin < closeStart || line[origin] === "\n")
  }
}
const blockPrefix = (line: string) => {
  const matched = prefix.exec(line)?.[0] ?? ""
  return { length: matched.length, heading: matched.includes("#") }
}
const ordinaryBlock = (text: string, line: string, complete: boolean, final: boolean): PlainBlock => {
  if (!complete && (ambiguousPrefix.test(line) || openingFence.test(line)))
    return { fence: null, origins: [], consumed: 0 }
  const opening = fenceMarker.exec(line)
  if (opening?.[1] !== undefined) return { fence: opening[1], origins: [], consumed: line.length }
  const selected = blockPrefix(line)
  const start = selected.length
  if (selected.heading) return headingBlock(line, complete, start)
  const result = inlineOrigins(text.slice(start), final)
  return {
    fence: null,
    consumed: start + result.consumed,
    origins: result.origins.map((origin) => (origin < 0 ? origin : origin + start))
  }
}
