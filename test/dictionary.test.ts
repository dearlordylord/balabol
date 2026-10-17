import { buildDictionaryCatalog } from "../src/dictionary/provision.ts"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { Dictionary, sqliteDictionaryLayer } from "../src/dictionary/index.ts"
const metadata = {
  name: "English Wiktionary via Wiktextract",
  url: "https://kaikki.org/dictionary/rawdata.html",
  version: "fixture-1",
  license: "CC BY-SA 4.0"
} as const
const lines = async function* (...values: unknown[]) {
  yield " "
  for (const value of values) yield JSON.stringify(value)
}
const fixture = {
  word: "étudier",
  lang_code: "fr",
  pos: "verb",
  etymology_text: "From Latin studiare.",
  senses: [{ glosses: ["to study"], examples: [{ text: "Je veux étudier." }] }],
  forms: [{ form: "étudions", tags: ["first-person", "plural"] }],
  related: [{ word: "étude" }],
  translations: [{ word: "study", code: "en" }]
}
const lookup = (path: string, word: string, extra: { limit?: number; offset?: number; language?: string } = {}) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        return yield* (yield* Dictionary).lookup({ language: "fr", word, ...extra })
      }).pipe(Effect.provide(sqliteDictionaryLayer(path)))
    )
  )
describe("local dictionary", () => {
  it("looks up NFC lemmas and inflections with source-grounded etymology and bounded pages", async () => {
    const directory = await mkdtemp(join(tmpdir(), "balabol-dictionary-"))
    const path = join(directory, "catalog.sqlite")
    try {
      await buildDictionaryCatalog({
        source: lines(
          fixture,
          { title: "redirect", redirect: "étudier" },
          { ...fixture, pos: "noun" },
          { word: "skip", lang_code: "de" }
        ),
        destination: path,
        metadata,
        languages: ["fr", "en", "ru"]
      })
      const page = await lookup(path, "e\u0301tudions", { limit: 1 })
      expect(page.entries).toHaveLength(1)
      expect(page.nextOffset).toBe(1)
      expect(page.entries[0]).toMatchObject({
        word: "étudier",
        etymologyText: "From Latin studiare.",
        related: [{ kind: "related", word: "étude", language: null }]
      })
      expect((await lookup(path, "étudions", { offset: 1, limit: 1 })).nextOffset).toBeNull()
      expect((await lookup(path, "missing")).entries).toEqual([])
      await expect(lookup(path, "test", { language: "ja" })).rejects.toMatchObject({
        _tag: "DictionaryRejected",
        code: "UnsupportedLanguage"
      })
      await expect(lookup(path, "test", { limit: 11 })).rejects.toMatchObject({
        _tag: "DictionaryRejected",
        code: "InvalidQuery"
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  it("keeps the previous catalogue when malformed input or cancellation prevents publication", async () => {
    const directory = await mkdtemp(join(tmpdir(), "balabol-dictionary-"))
    const path = join(directory, "catalog.sqlite")
    try {
      await buildDictionaryCatalog({ source: lines(fixture), destination: path, metadata, languages: ["fr"] })
      const before = await readFile(path)
      await expect(
        buildDictionaryCatalog({ source: lines({ unknown: true }), destination: path, metadata, languages: ["fr"] })
      ).rejects.toThrow()
      await expect(
        buildDictionaryCatalog({
          source: lines({ ...fixture, senses: [{ glosses: [3] }] }),
          destination: path,
          metadata,
          languages: ["fr"]
        })
      ).rejects.toThrow()
      expect(await readFile(path)).toEqual(before)
      const controller = new AbortController()
      controller.abort()
      await expect(
        buildDictionaryCatalog({
          source: lines(fixture),
          destination: path,
          metadata,
          languages: ["fr"],
          signal: controller.signal
        })
      ).rejects.toThrow()
      expect((await lookup(path, "étudier")).entries).toHaveLength(1)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  it("distinguishes a missing catalogue from corrupt stored data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "balabol-dictionary-"))
    const path = join(directory, "missing.sqlite")
    try {
      await expect(lookup(path, "test")).rejects.toMatchObject({ _tag: "DictionaryUnavailable", reason: "Missing" })
      await writeFile(path, "not sqlite")
      await expect(lookup(path, "test")).rejects.toMatchObject({ _tag: "DictionaryUnavailable", reason: "Corrupt" })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

it("bounds projected lexical fields and distinguishes links from ancestry", async () => {
  const { projectDictionaryEntry } = await import("../src/dictionary/projection.ts")
  const entry = projectDictionaryEntry({
    word: "a".repeat(500),
    lang_code: "en",
    pos: "n".repeat(90),
    senses: Array.from({ length: 21 }, () => ({
      glosses: Array.from({ length: 11 }, () => "x".repeat(1100)),
      tags: Array.from({ length: 21 }, () => "t".repeat(90)),
      examples: [
        { type: "quotation", text: "Do not relabel quotations" },
        { type: "example", text: "A normal example." },
        {}
      ]
    })),
    forms: [{ form: "tests" }],
    sounds: [{}, { ipa: "/test/", tags: ["UK"] }],
    etymology_text: "e".repeat(4100),
    etymology_links: [["test", "test#English"]],
    related: [{ word: "test", lang_code: "en" }],
    derived: [{ word: "testing" }],
    translations: [{}, { word: "тест", code: "ru", sense: "test" }, { word: "essai", code: "fr" }]
  })
  expect(entry.truncated).toBe(true)
  expect(entry.senses).toHaveLength(20)
  expect(entry.senses[0]?.examples).toEqual(["A normal example."])
  expect(entry.etymologyLinks).toEqual([{ word: "test", target: "test#English" }])
  expect(entry.related.map((item) => item.kind)).toEqual(["related", "derived"])
  expect(entry.translations).toHaveLength(2)
  expect(projectDictionaryEntry({ word: "test", lang_code: "en" })).toMatchObject({
    partOfSpeech: "unknown",
    etymologyText: null,
    truncated: false
  })
})

it("uses the lookup index and enforces byte limits without truncating identities", async () => {
  const { DatabaseSync } = await import("node:sqlite")
  const directory = await mkdtemp(join(tmpdir(), "balabol-dictionary-"))
  const path = join(directory, "catalog.sqlite")
  try {
    await buildDictionaryCatalog({ source: lines(fixture), destination: path, metadata, languages: ["fr"] })
    const db = new DatabaseSync(path)
    const plan = JSON.stringify(
      db.prepare("EXPLAIN QUERY PLAN SELECT entry_id FROM lookup WHERE language=? AND word=?").all("fr", "étudier")
    )
    expect(plan).toContain("SEARCH lookup USING COVERING INDEX lookup_word")
    db.prepare("UPDATE entries SET payload=?").run("x".repeat(300000))
    db.close()
    await expect(lookup(path, "étudier")).rejects.toMatchObject({ _tag: "DictionaryRejected", code: "ResultTooLarge" })
    await expect(
      buildDictionaryCatalog({
        source: lines({ ...fixture, word: "a".repeat(513) }),
        destination: path,
        metadata,
        languages: ["fr"]
      })
    ).rejects.toThrow()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it("paginates by encoded byte budget without skipping entries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "balabol-dictionary-"))
  const path = join(directory, "catalog.sqlite")
  try {
    const large = {
      ...fixture,
      senses: Array.from({ length: 20 }, () => ({ glosses: Array.from({ length: 10 }, () => "g".repeat(1000)) }))
    }
    await buildDictionaryCatalog({ source: lines(large, large, large), destination: path, metadata, languages: ["fr"] })
    const first = await lookup(path, "étudier", { limit: 3 })
    expect(first.entries).toHaveLength(1)
    expect(first.nextOffset).toBe(1)
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(262144)
    const second = await lookup(path, "étudier", { offset: 1, limit: 3 })
    expect(second.nextOffset).toBe(2)
    expect((await lookup(path, "étudier", { offset: 2, limit: 3 })).nextOffset).toBeNull()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it("indexes forms beyond the bounded tool projection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "balabol-dictionary-"))
  const path = join(directory, "catalog.sqlite")
  try {
    await buildDictionaryCatalog({
      source: lines({ ...fixture, forms: Array.from({ length: 40 }, (_, index) => ({ form: `form${index}` })) }),
      destination: path,
      metadata,
      languages: ["fr"]
    })
    const page = await lookup(path, "form39")
    expect(page.entries).toHaveLength(1)
    expect(page.entries[0]?.forms).toHaveLength(30)
    expect(page.entries[0]?.truncated).toBe(true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it("validates the staged catalogue before publication and rejects empty selections", async () => {
  const directory = await mkdtemp(join(tmpdir(), "balabol-dictionary-"))
  const path = join(directory, "catalog.sqlite")
  try {
    await buildDictionaryCatalog({ source: lines(fixture), destination: path, metadata, languages: ["fr"] })
    const before = await readFile(path)
    await expect(
      buildDictionaryCatalog({
        source: lines({ ...fixture, word: "replacement" }),
        destination: path,
        metadata,
        languages: ["fr"],
        validate: async (staging) => {
          expect((await lookup(staging, "replacement")).entries).toHaveLength(1)
          expect(await readFile(path)).toEqual(before)
          throw new Error("Catalogue qualification failed")
        }
      })
    ).rejects.toThrow("Catalogue qualification failed")
    expect(await readFile(path)).toEqual(before)
    await expect(
      buildDictionaryCatalog({
        source: lines({ word: "ignored", lang_code: "de" }),
        destination: path,
        metadata,
        languages: ["fr"]
      })
    ).rejects.toThrow("no selected entries")
    expect(await readFile(path)).toEqual(before)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it("retains the previous catalogue when cancellation happens after an imported entry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "balabol-dictionary-"))
  const path = join(directory, "catalog.sqlite")
  try {
    await buildDictionaryCatalog({ source: lines(fixture), destination: path, metadata, languages: ["fr"] })
    const before = await readFile(path)
    const controller = new AbortController()
    const source = async function* () {
      yield JSON.stringify({ ...fixture, word: "replacement" })
      controller.abort()
      yield JSON.stringify(fixture)
    }
    await expect(
      buildDictionaryCatalog({
        source: source(),
        destination: path,
        metadata,
        languages: ["fr"],
        signal: controller.signal
      })
    ).rejects.toThrow()
    expect(await readFile(path)).toEqual(before)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it("isolates identical spellings by language and emits usable cursors past ten thousand entries", async () => {
  const { DatabaseSync } = await import("node:sqlite")
  const directory = await mkdtemp(join(tmpdir(), "balabol-dictionary-"))
  const path = join(directory, "catalog.sqlite")
  try {
    await buildDictionaryCatalog({
      source: lines(
        { word: "pain", lang_code: "en", senses: [{ glosses: ["physical suffering"] }] },
        { word: "pain", lang_code: "fr", senses: [{ glosses: ["bread"] }] }
      ),
      destination: path,
      metadata,
      languages: ["fr", "en"]
    })
    expect((await lookup(path, "pain")).entries[0]?.senses[0]?.glosses).toEqual(["bread"])
    expect((await lookup(path, "pain", { language: "en" })).entries[0]?.senses[0]?.glosses).toEqual([
      "physical suffering"
    ])
    const db = new DatabaseSync(path)
    db.exec("BEGIN")
    const copy = db.prepare(
      "INSERT INTO entries(language,word,payload) SELECT language,word,payload FROM entries WHERE id=2"
    )
    const link = db.prepare("INSERT INTO lookup VALUES ('fr','pain',?)")
    for (let index = 0; index < 10001; index += 1) link.run(copy.run().lastInsertRowid)
    db.exec("COMMIT")
    db.close()
    const page = await lookup(path, "pain", { offset: 10000, limit: 1 })
    expect(page.nextOffset).toBe(10001)
    expect((await lookup(path, "pain", { offset: page.nextOffset ?? 0, limit: 1 })).nextOffset).toBeNull()
    expect((await lookup(path, "pain", { offset: Number.MAX_SAFE_INTEGER, limit: 10 })).entries).toEqual([])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
