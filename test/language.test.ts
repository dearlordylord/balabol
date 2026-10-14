import { Schema } from "effect"
import { expect, it } from "vitest"
import { LanguageTag, LanguageTags, validLanguageSpans } from "../src/language/index.ts"
it("canonicalizes language tags without restricting the domain to fixture languages", () => {
  expect(Schema.decodeUnknownSync(LanguageTag)("PT-br")).toBe("pt-BR")
  expect(Schema.decodeUnknownSync(LanguageTag)("iw")).toBe("he")
  expect(Schema.is(LanguageTag)("fr")).toBe(true)
  expect(() => Schema.decodeUnknownSync(LanguageTag)("not_a_tag")).toThrow()
  expect(() => Schema.decodeUnknownSync(LanguageTags)(["en", "EN"])).toThrow()
})
it("validates UTF-16 ranges", () => {
  const text = "😀bonjourHello"
  const spans = [
    { language: "fr", start: 0, end: 9 },
    { language: "en", start: 9, end: 14 }
  ]
  expect(validLanguageSpans(text, spans)).toBe(true)
  expect(validLanguageSpans(text, [{ language: "en", start: 1, end: 3 }])).toBe(false)
  expect(validLanguageSpans(text, [{ language: "en", start: 0, end: 1 }])).toBe(false)
  expect(validLanguageSpans(text, [{ language: "en", start: 5, end: 4 }])).toBe(false)
  expect(validLanguageSpans(text, [{ language: "en", start: 0, end: 20 }])).toBe(false)
  expect(
    validLanguageSpans(text, [
      { language: "en", start: 0, end: 5 },
      { language: "fr", start: 4, end: 7 }
    ])
  ).toBe(false)
})
