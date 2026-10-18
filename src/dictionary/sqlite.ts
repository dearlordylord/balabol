import { dictionaryLimits } from "./limits.ts"
import { DatabaseSync } from "node:sqlite"
import { Effect, Layer, Schema } from "effect"
import {
  DictionaryEntry,
  DictionaryPage,
  DictionaryQuery,
  DictionaryRejected,
  DictionarySource,
  DictionaryUnavailable
} from "./models.ts"
import { Dictionary } from "./service.ts"
const unavailable = (error: unknown) =>
  new DictionaryUnavailable({
    reason:
      error instanceof Error &&
      "code" in error &&
      error.code === "ERR_SQLITE_ERROR" &&
      error.message.includes("unable to open")
        ? "Missing"
        : "Corrupt",
    message: "Local dictionary unavailable; run pnpm prepare:dictionary, then restart the backend"
  })
const query = (raw: DictionaryQuery) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(DictionaryQuery, { onExcessProperty: "error" })(raw),
    catch: () => new DictionaryRejected({ code: "InvalidQuery", message: "Invalid dictionary lookup" })
  })
const Row = Schema.Struct({ payload: Schema.String })
const ResultRow = Schema.Struct({ payload: Schema.String, bytes: Schema.Number })
const tooLarge = () =>
  new DictionaryRejected({ code: "ResultTooLarge", message: "Dictionary entry exceeds the result byte limit" })
const decodeRow = (value: unknown) => {
  const row = Schema.decodeUnknownSync(ResultRow)(value)
  if (row.bytes > dictionaryLimits.resultBytes) throw tooLarge()
  return Schema.decodeUnknownSync(DictionaryEntry)(JSON.parse(row.payload))
}
const fitEntries = (entries: readonly DictionaryEntry[], envelopeBytes: number) => {
  let bytes = envelopeBytes
  const selected: DictionaryEntry[] = []
  for (const entry of entries) {
    const size = Buffer.byteLength(JSON.stringify(entry)) + 1
    if (bytes + size > dictionaryLimits.resultBytes) break
    selected.push(entry)
    bytes += size
  }
  if (entries.length > 0 && selected.length === 0) throw tooLarge()
  return selected
}
const readSource = (database: DatabaseSync) =>
  Schema.decodeUnknownSync(DictionarySource)(
    JSON.parse(
      Schema.decodeUnknownSync(Row)(database.prepare("SELECT substr(payload,1,262144) AS payload FROM metadata").get())
        .payload
    )
  )
const read = (database: DatabaseSync, source: DictionarySource, request: DictionaryQuery): DictionaryPage => {
  const offset = request.offset ?? 0
  const limit = request.limit ?? dictionaryLimits.defaultPageSize
  const word = request.word.normalize("NFC")
  const rows = database
    .prepare(
      "SELECT substr(entries.payload,1,262144) AS payload, length(CAST(entries.payload AS BLOB)) AS bytes FROM lookup JOIN entries ON entries.id=lookup.entry_id WHERE lookup.language=? AND lookup.word=? ORDER BY entries.id LIMIT ? OFFSET ?"
    )
    .all(request.language, word, limit + 1, offset)
  const envelope = { source, language: request.language, word, entries: [], nextOffset: offset + limit }
  const entries = fitEntries(rows.slice(0, limit).map(decodeRow), Buffer.byteLength(JSON.stringify(envelope)))
  const nextOffset = rows.length > entries.length ? offset + entries.length : null
  if (nextOffset !== null && !Number.isSafeInteger(nextOffset)) throw tooLarge()
  return Schema.decodeUnknownSync(DictionaryPage)({ ...envelope, entries, nextOffset })
}
/** Read-only, backend-scoped handle. Atomic catalogue replacement becomes visible after backend restart. */
export const sqliteDictionaryLayer = (path: string) =>
  Layer.effect(
    Dictionary,
    Effect.gen(function* () {
      const opened = yield* Effect.result(
        Effect.acquireRelease(
          Effect.try({ try: () => new DatabaseSync(path, { readOnly: true }), catch: unavailable }),
          (database) => Effect.sync(() => database.close())
        )
      )
      if (opened._tag === "Failure") {
        yield* Effect.logWarning(opened.failure.message)
        return Dictionary.of({ lookup: () => Effect.fail(opened.failure) })
      }
      const database = opened.success
      const source = yield* Effect.result(Effect.try({ try: () => readSource(database), catch: unavailable }))
      if (source._tag === "Failure") yield* Effect.logWarning(source.failure.message)
      else yield* Effect.logInfo("Local dictionary catalog opened (ru/fr/en)")
      return Dictionary.of({
        lookup: (raw) =>
          query(raw).pipe(
            Effect.flatMap((request): Effect.Effect<DictionaryPage, DictionaryRejected | DictionaryUnavailable> => {
              if (!["ru", "fr", "en"].includes(request.language))
                return Effect.fail(
                  new DictionaryRejected({ code: "UnsupportedLanguage", message: "Dictionary supports ru, fr and en" })
                )
              if (source._tag === "Failure") return Effect.fail(source.failure)
              return Effect.try({
                try: () => read(database, source.success, request),
                catch: (error) => (error instanceof DictionaryRejected ? error : unavailable(error))
              })
            })
          )
      })
    })
  )
