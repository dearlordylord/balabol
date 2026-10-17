import { randomUUID } from "node:crypto"
import { rename, rm } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import { Schema } from "effect"
import { DictionarySource } from "./models.ts"
import { dictionaryLookupWords, projectDictionaryEntry } from "./projection.ts"
const Identity = Schema.Union([
  Schema.Struct({ lang_code: Schema.String }),
  Schema.Struct({ title: Schema.String, redirect: Schema.String })
])
export interface DictionaryBuildOptions {
  readonly source: AsyncIterable<string>
  readonly destination: string
  readonly metadata: DictionarySource
  readonly languages: readonly string[]
  readonly signal?: AbortSignal
  readonly validate?: (stagingPath: string) => Promise<void>
}
const populate = async (database: DatabaseSync, options: DictionaryBuildOptions): Promise<number> => {
  let entries = 0
  const insert = database.prepare("INSERT INTO entries(language,word,payload) VALUES (?,?,?)")
  const lookup = database.prepare("INSERT INTO lookup VALUES (?,?,?)")
  for await (const line of options.source) {
    options.signal?.throwIfAborted()
    if (line.trim() === "") continue
    const raw: unknown = JSON.parse(line)
    const identity = Schema.decodeUnknownSync(Identity)(raw)
    if (!("lang_code" in identity)) continue
    if (!options.languages.includes(identity.lang_code)) continue
    const entry = projectDictionaryEntry(raw)
    const inserted = insert.run(entry.language, entry.word, JSON.stringify(entry))
    for (const word of dictionaryLookupWords(raw)) lookup.run(entry.language, word, inserted.lastInsertRowid)
    entries += 1
  }
  return entries
}
/** Builds a private sibling index; publication is atomic and leaves an existing catalogue untouched on failure. */
export const buildDictionaryCatalog = async (options: DictionaryBuildOptions): Promise<{ entries: number }> => {
  const metadata = Schema.decodeUnknownSync(DictionarySource)(options.metadata)
  const temporary = `${options.destination}.${randomUUID()}.staging`
  const database = new DatabaseSync(temporary)
  let entries = 0
  try {
    database.exec(
      "CREATE TABLE metadata (payload TEXT NOT NULL); CREATE TABLE entries (id INTEGER PRIMARY KEY, language TEXT NOT NULL, word TEXT NOT NULL, payload TEXT NOT NULL); CREATE TABLE lookup (language TEXT NOT NULL, word TEXT NOT NULL, entry_id INTEGER NOT NULL); CREATE INDEX lookup_word ON lookup(language, word, entry_id); BEGIN"
    )
    database.prepare("INSERT INTO metadata VALUES (?)").run(JSON.stringify(metadata))
    entries = await populate(database, options)
    options.signal?.throwIfAborted()
    if (entries === 0) throw new Error("Dictionary catalogue contains no selected entries")
    database.exec("COMMIT")
    database.close()
    await options.validate?.(temporary)
    options.signal?.throwIfAborted()
    await rename(temporary, options.destination)
    return { entries }
  } catch (error) {
    if (database.isOpen) {
      if (database.isTransaction) database.exec("ROLLBACK")
      database.close()
    }
    await rm(temporary, { force: true })
    throw error
  }
}
