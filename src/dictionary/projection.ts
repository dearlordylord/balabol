import { dictionaryLimits } from "./limits.ts"
import { Schema } from "effect"
import { DictionaryEntry } from "./models.ts"
const Raw = Schema.Struct({
  word: Schema.String.check(Schema.isMaxLength(dictionaryLimits.wordLength)),
  lang_code: Schema.String,
  pos: Schema.optionalKey(Schema.String),
  senses: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        glosses: Schema.optionalKey(Schema.Array(Schema.String)),
        tags: Schema.optionalKey(Schema.Array(Schema.String)),
        examples: Schema.optionalKey(
          Schema.Array(
            Schema.Struct({ text: Schema.optionalKey(Schema.String), type: Schema.optionalKey(Schema.String) })
          )
        )
      })
    )
  ),
  forms: Schema.optionalKey(
    Schema.Array(Schema.Struct({ form: Schema.String, tags: Schema.optionalKey(Schema.Array(Schema.String)) }))
  ),
  sounds: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ ipa: Schema.optionalKey(Schema.String), tags: Schema.optionalKey(Schema.Array(Schema.String)) })
    )
  ),
  etymology_links: Schema.optionalKey(Schema.Array(Schema.Tuple([Schema.String, Schema.String]))),
  etymology_text: Schema.optionalKey(Schema.String),
  related: Schema.optionalKey(
    Schema.Array(Schema.Struct({ word: Schema.String, lang_code: Schema.optionalKey(Schema.String) }))
  ),
  derived: Schema.optionalKey(
    Schema.Array(Schema.Struct({ word: Schema.String, lang_code: Schema.optionalKey(Schema.String) }))
  ),
  translations: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        word: Schema.optionalKey(Schema.String),
        code: Schema.optionalKey(Schema.String),
        sense: Schema.optionalKey(Schema.String)
      })
    )
  )
})
const decode = Schema.decodeUnknownSync(Raw)
/** Source etymology prose remains asserted evidence; related/derived lists never imply shared ancestry. */
export const projectDictionaryEntry = (value: unknown): DictionaryEntry => {
  const raw = decode(value)
  let truncated = false
  const text = (value: string, maximum: number) => {
    if (value.length > maximum) truncated = true
    return value.slice(0, maximum)
  }
  const items = <A>(values: readonly A[] | undefined, maximum: number) => {
    if (values !== undefined && values.length > maximum) truncated = true
    return (values ?? []).slice(0, maximum)
  }
  const tags = (values: readonly string[] | undefined) =>
    items(values, dictionaryLimits.senseCount).map((tag) => text(tag, dictionaryLimits.tagLength))
  const related = (kind: "related" | "derived", values: typeof raw.related) =>
    items(values, dictionaryLimits.relationHalf).map((item) => ({
      kind,
      word: text(item.word.normalize("NFC"), dictionaryLimits.wordLength),
      language: item.lang_code ?? null
    }))
  return Schema.decodeUnknownSync(DictionaryEntry)({
    word: text(raw.word.normalize("NFC"), dictionaryLimits.wordLength),
    language: raw.lang_code,
    partOfSpeech: text(raw.pos ?? "unknown", dictionaryLimits.tagLength),
    senses: items(raw.senses, dictionaryLimits.senseCount).map((sense) => ({
      glosses: items(sense.glosses, dictionaryLimits.pageSize).map((gloss) => text(gloss, dictionaryLimits.textLength)),
      tags: tags(sense.tags),
      examples: items(sense.examples, dictionaryLimits.exampleCount).flatMap((example) =>
        example.text === undefined || example.type === "quotation"
          ? []
          : [text(example.text, dictionaryLimits.textLength)]
      )
    })),
    forms: items(raw.forms, dictionaryLimits.relationCount).map((form) => ({
      word: text(form.form.normalize("NFC"), dictionaryLimits.wordLength),
      tags: tags(form.tags)
    })),
    pronunciations: items(raw.sounds, dictionaryLimits.pageSize).flatMap((sound) =>
      sound.ipa === undefined ? [] : [{ ipa: text(sound.ipa, dictionaryLimits.ipaLength), tags: tags(sound.tags) }]
    ),
    sourceUrl: `https://en.wiktionary.org/wiki/${encodeURIComponent(raw.word)}`,
    etymologyText: raw.etymology_text === undefined ? null : text(raw.etymology_text, dictionaryLimits.etymologyLength),
    etymologyLinks: items(raw.etymology_links, dictionaryLimits.relationCount).map(([word, target]) => ({
      word: text(word, dictionaryLimits.wordLength),
      target: text(target, dictionaryLimits.textLength)
    })),
    related: [...related("related", raw.related), ...related("derived", raw.derived)],
    translations: items(raw.translations, dictionaryLimits.relationCount).flatMap((item) =>
      item.word === undefined || item.code === undefined
        ? []
        : [
            {
              word: text(item.word, dictionaryLimits.wordLength),
              language: text(item.code, dictionaryLimits.languageLength),
              sense: item.sense === undefined ? null : text(item.sense, dictionaryLimits.textLength)
            }
          ]
    ),
    truncated
  })
}

/** Index all exact source forms even when the returned examples of forms are truncated. */
export const dictionaryLookupWords = (value: unknown): readonly string[] => {
  const raw = Schema.decodeUnknownSync(Schema.Struct({ word: Schema.String, forms: Raw.fields.forms }))(value)
  return [
    ...new Set(
      [raw.word, ...(raw.forms ?? []).map((form) => form.form)]
        .filter((word) => word.length <= dictionaryLimits.wordLength)
        .map((word) => word.normalize("NFC"))
    )
  ]
}
