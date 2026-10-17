import { dictionaryLimits } from "./limits.ts"
import { Schema } from "effect"
const text = (maximum: number) => Schema.String.check(Schema.isMaxLength(maximum))
const list = <A extends Schema.Top>(item: A, maximum: number) => Schema.Array(item).check(Schema.isMaxLength(maximum))
const Tags = list(text(dictionaryLimits.tagLength), dictionaryLimits.senseCount)
export const DictionaryQuery = Schema.Struct({
  language: text(dictionaryLimits.languageLength),
  word: text(dictionaryLimits.wordLength).check(Schema.isMinLength(1)),
  offset: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(dictionaryLimits.maximumOffset))
  ),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(dictionaryLimits.pageSize))
  )
})
export type DictionaryQuery = typeof DictionaryQuery.Type
export const DictionarySource = Schema.Struct({
  name: Schema.Literal("English Wiktionary via Wiktextract"),
  url: text(dictionaryLimits.textLength),
  version: text(dictionaryLimits.wordLength),
  license: text(dictionaryLimits.ipaLength),
  dumpDate: Schema.optionalKey(text(dictionaryLimits.wordLength)),
  extractionDate: Schema.optionalKey(text(dictionaryLimits.wordLength)),
  extractorRevision: Schema.optionalKey(text(dictionaryLimits.wordLength)),
  archiveSha256: Schema.optionalKey(text(dictionaryLimits.wordLength))
})
export type DictionarySource = typeof DictionarySource.Type
export const DictionaryEntry = Schema.Struct({
  word: text(dictionaryLimits.wordLength),
  language: text(dictionaryLimits.languageLength),
  partOfSpeech: text(dictionaryLimits.tagLength),
  senses: list(
    Schema.Struct({
      glosses: list(text(dictionaryLimits.textLength), dictionaryLimits.pageSize),
      tags: Tags,
      examples: list(text(dictionaryLimits.textLength), dictionaryLimits.exampleCount)
    }),
    dictionaryLimits.senseCount
  ),
  forms: list(Schema.Struct({ word: text(dictionaryLimits.wordLength), tags: Tags }), dictionaryLimits.relationCount),
  pronunciations: list(Schema.Struct({ ipa: text(dictionaryLimits.ipaLength), tags: Tags }), dictionaryLimits.pageSize),
  sourceUrl: text(dictionaryLimits.sourceUrlLength),
  etymologyText: Schema.NullOr(text(dictionaryLimits.etymologyLength)),
  etymologyLinks: list(
    Schema.Struct({ word: text(dictionaryLimits.wordLength), target: text(dictionaryLimits.textLength) }),
    dictionaryLimits.relationCount
  ),
  related: list(
    Schema.Struct({
      kind: Schema.Literals(["related", "derived", "etymological"]),
      word: text(dictionaryLimits.wordLength),
      language: Schema.NullOr(text(dictionaryLimits.languageLength))
    }),
    dictionaryLimits.relationCount
  ),
  translations: list(
    Schema.Struct({
      word: text(dictionaryLimits.wordLength),
      language: text(dictionaryLimits.languageLength),
      sense: Schema.NullOr(text(dictionaryLimits.textLength))
    }),
    dictionaryLimits.relationCount
  ),
  truncated: Schema.Boolean
})
export type DictionaryEntry = typeof DictionaryEntry.Type
export const DictionaryPage = Schema.Struct({
  source: DictionarySource,
  language: text(dictionaryLimits.languageLength),
  word: text(dictionaryLimits.wordLength),
  entries: list(DictionaryEntry, dictionaryLimits.pageSize),
  nextOffset: Schema.NullOr(Schema.Int)
})
export type DictionaryPage = typeof DictionaryPage.Type
export class DictionaryRejected extends Schema.TaggedError<DictionaryRejected>()("DictionaryRejected", {
  code: Schema.Literals(["InvalidQuery", "UnsupportedLanguage", "ResultTooLarge"]),
  message: Schema.String
}) {}
export class DictionaryUnavailable extends Schema.TaggedError<DictionaryUnavailable>()("DictionaryUnavailable", {
  reason: Schema.Literals(["Missing", "Corrupt", "Disabled"]),
  message: Schema.String
}) {}
