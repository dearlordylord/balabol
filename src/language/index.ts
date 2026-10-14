import { Schema, SchemaGetter } from "effect"
const maximumTagLength = 64
const maximumLanguages = 32
const maximumSpans = 1000
const highStart = 0xd800
const highEnd = 0xdbff
const lowStart = 0xdc00
const lowEnd = 0xdfff
export const canonicalLanguageTag = (tag: string): string | undefined => {
  try {
    return Intl.getCanonicalLocales(tag)[0]
  } catch {
    return undefined
  }
}
export const LanguageTag = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(maximumTagLength),
  Schema.makeFilter((tag) => canonicalLanguageTag(tag) !== undefined)
).pipe(
  Schema.decodeTo(
    Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(maximumTagLength),
      Schema.makeFilter((tag) => canonicalLanguageTag(tag) === tag)
    ),
    { decode: SchemaGetter.transform((tag) => canonicalLanguageTag(tag) ?? tag), encode: SchemaGetter.passthrough() }
  )
)
export type LanguageTag = typeof LanguageTag.Type
export const LanguageTags = Schema.Array(LanguageTag).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(maximumLanguages),
  Schema.isUnique()
)
const Offset = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const LanguageSpan = Schema.Struct({ language: LanguageTag, start: Offset, end: Offset })
export type LanguageSpan = typeof LanguageSpan.Type
export const LanguageSpans = Schema.Array(LanguageSpan).check(Schema.isMaxLength(maximumSpans))
export const isScalarBoundary = (text: string, offset: number) => {
  const before = text.charCodeAt(offset - 1)
  const after = text.charCodeAt(offset)
  return !(before >= highStart && before <= highEnd && after >= lowStart && after <= lowEnd)
}
export const validLanguageSpans = (text: string, spans: readonly LanguageSpan[]) =>
  spans.every(
    (span, index) =>
      span.start < span.end &&
      span.end <= text.length &&
      span.start >= (spans[index - 1]?.end ?? 0) &&
      isScalarBoundary(text, span.start) &&
      isScalarBoundary(text, span.end)
  )
