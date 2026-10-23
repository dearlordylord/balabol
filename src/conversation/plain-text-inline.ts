/** A source index preserves a UTF-16 unit; -1 is an unannotated space separating a link label and destination. */
export interface PlainInline {
  readonly consumed: number
  readonly origins: readonly number[]
}
const insertedSpace = -1
const maximumNesting = 16
const pairWidth = 2
const highSurrogateStart = 0xd800
const highSurrogateEnd = 0xdbff
const positions = (start: number, end: number) => Array.from({ length: end - start }, (_, index) => start + index)
const punctuation = /[\\`*_{}[\]()#+.!>~-]/u
const word = /[\p{L}\p{N}]/u
const delimiterCharacters = new Set(["*", "_", "~", "`"])
const character = (text: string, index: number) => text[index] ?? ""
const run = (text: string, start: number) => {
  let end = start + 1
  while (text[end] === text[start]) end++
  return end - start
}
const precedingCharacter = (text: string, start: number, preceding: string) =>
  start === 0 ? preceding : character(text, start - 1)
const marker = (text: string, start: number, preceding: string): string | undefined => {
  const char = character(text, start)
  if (!delimiterCharacters.has(char)) return undefined
  const length = run(text, start)
  if (char === "~" && length !== pairWidth) return undefined
  if (char !== "`" && word.test(precedingCharacter(text, start, preceding))) return undefined
  if (char !== "`" && /\s/u.test(character(text, start + length))) return undefined
  return char.repeat(length)
}
const closeBoundary = (text: string, delimiter: string, end: number) => {
  if (text[end - 1] === delimiter[0] || /\s/u.test(character(text, end - 1))) return false
  return !delimiter.startsWith("_") || !word.test(character(text, end + delimiter.length))
}
const validClose = (text: string, delimiter: string, end: number, final: boolean) =>
  closeBoundary(text, delimiter, end) &&
  run(text, end) === delimiter.length &&
  (final || end + delimiter.length < text.length)
const closeMarker = (text: string, delimiter: string, start: number, final: boolean) => {
  let end = text.indexOf(delimiter, start)
  while (end >= 0) {
    if (validClose(text, delimiter, end, final)) return end
    end = text.indexOf(delimiter, end + delimiter.length)
  }
  return undefined
}
const closingParenthesis = (text: string, start: number) => {
  let depth = 1
  for (let cursor = start; cursor < text.length; cursor++) {
    if (text[cursor] === "(") depth++
    if (text[cursor] === ")") depth--
    if (depth === 0) return cursor
  }
  return undefined
}
const link = (text: string, start: number, depth: number): PlainInline | undefined => {
  const labelEnd = text.indexOf("](", start + 1)
  if (labelEnd < 0) return undefined
  const end = closingParenthesis(text, labelEnd + pairWidth)
  if (end === undefined) return undefined
  const label = inlineOrigins(text.slice(start + 1, labelEnd), true, depth + 1)
  return {
    consumed: end + 1 - start,
    origins: [
      ...label.origins.map((origin) => (origin < 0 ? origin : origin + start + 1)),
      insertedSpace,
      ...positions(labelEnd + 1, end + 1)
    ]
  }
}
const delimited = (
  text: string,
  start: number,
  delimiter: string,
  depth: number,
  final: boolean
): PlainInline | undefined => {
  const content = start + delimiter.length
  const end = closeMarker(text, delimiter, content, final)
  if (end === undefined) return undefined
  const origins = delimiter.startsWith("`")
    ? positions(content, end)
    : inlineOrigins(text.slice(content, end), true, depth + 1).origins.map((origin) =>
        origin < 0 ? origin : origin + content
      )
  return { consumed: end + delimiter.length - start, origins }
}
const highSurrogate = (character: string) => {
  const unit = character.charCodeAt(0)
  return unit >= highSurrogateStart && unit <= highSurrogateEnd
}
const special = (
  text: string,
  cursor: number,
  depth: number,
  final: boolean,
  preceding: string
): PlainInline | undefined => {
  if (text[cursor] === "[" || (text[cursor] === "!" && text[cursor + 1] === "[")) {
    const image = text[cursor] === "!"
    const result = link(text, cursor + Number(image), depth)
    return result === undefined ? undefined : { ...result, consumed: result.consumed + Number(image) }
  }
  const delimiter = marker(text, cursor, preceding)
  return delimiter === undefined ? { consumed: 1, origins: [cursor] } : delimited(text, cursor, delimiter, depth, final)
}
const literal = (cursor: number): PlainInline => ({ consumed: 1, origins: [cursor] })
const ambiguousTail = (text: string, cursor: number) =>
  cursor === text.length - 1 && (highSurrogate(character(text, cursor)) || /[!~\\]/u.test(character(text, cursor)))
const lexeme = (
  text: string,
  cursor: number,
  final: boolean,
  depth: number,
  preceding: string
): PlainInline | undefined => {
  if (!final && ambiguousTail(text, cursor)) return undefined
  if (character(text, cursor) === "\\" && punctuation.test(character(text, cursor + 1)))
    return { consumed: pairWidth, origins: [cursor + 1] }
  return depth >= maximumNesting ? literal(cursor) : special(text, cursor, depth, final, preceding)
}
/** Ordinary text streams immediately; an unresolved construct waits until a boundary decides whether it is literal. */
const parseInline = (text: string, final: boolean, depth: number, preceding: string): PlainInline => {
  const origins: number[] = []
  let cursor = 0
  while (cursor < text.length) {
    const result = lexeme(text, cursor, final, depth, preceding)
    if (result === undefined && !final) break
    const next = result ?? literal(cursor)
    origins.push(...next.origins)
    cursor += next.consumed
    if (depth === 0 && text[cursor - 1] === "\n") break
  }
  return { consumed: cursor, origins }
}

export const inlineOrigins = (text: string, final: boolean, depth = 0, preceding = ""): PlainInline =>
  parseInline(text, final, depth, preceding)
