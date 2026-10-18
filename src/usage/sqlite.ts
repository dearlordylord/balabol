import { DatabaseSync } from "node:sqlite"
import { Effect, Layer, Schema } from "effect"
import { LedgerSnapshot, UsageAttempt, UsageLedger, usageUnavailable } from "./contracts.ts"

/** Production borrows the database only after Bootstrap acquires the shared writer lease. */
export const borrowedUsageLayer = (database: DatabaseSync) => Layer.effect(UsageLedger, makeLedger(database))
export const sqliteUsageLayer = (path: string) =>
  Layer.effect(
    UsageLedger,
    Effect.gen(function* () {
      const database = yield* Effect.acquireRelease(
        Effect.try({ try: () => new DatabaseSync(path), catch: () => usageUnavailable() }),
        (value) => Effect.sync(() => value.close())
      )
      return yield* makeLedger(database)
    })
  )
const makeLedger = (database: DatabaseSync) =>
  Effect.gen(function* () {
    yield* Effect.try({
      try: () =>
        database.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS usage_attempts (
      id TEXT PRIMARY KEY, category TEXT NOT NULL, model TEXT NOT NULL,
      started_at INTEGER NOT NULL, outcome TEXT NOT NULL, tokens TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS usage_health (id INTEGER PRIMARY KEY CHECK(id=1), degraded INTEGER NOT NULL);
    INSERT OR IGNORE INTO usage_health VALUES (1, 0);
    CREATE INDEX IF NOT EXISTS usage_attempt_time ON usage_attempts(started_at);
    UPDATE usage_attempts SET outcome='interrupted' WHERE outcome='running';
  `),
      catch: () => usageUnavailable()
    })
    let degraded = yield* Effect.try({
      try: () => database.prepare("SELECT degraded FROM usage_health WHERE id=1").get()?.degraded === 1,
      catch: () => usageUnavailable()
    })
    const guarded = <A>(work: () => A) =>
      Effect.try({
        try: work,
        catch: (error) => {
          degraded = true
          try {
            database.exec("UPDATE usage_health SET degraded=1 WHERE id=1")
          } catch {
            /* The current snapshot still exposes degradation while storage is unavailable. */
          }
          return usageUnavailable(Schema.isSchemaError(error) ? "InvalidSchema" : "Storage")
        }
      })
    return UsageLedger.of({
      record: (raw) =>
        guarded(() => {
          const value = Schema.decodeUnknownSync(UsageAttempt)(raw)
          database
            .prepare(`INSERT INTO usage_attempts VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET outcome=excluded.outcome,tokens=excluded.tokens
        WHERE usage_attempts.outcome='running'`)
            .run(value.id, value.category, value.model, value.startedAt, value.outcome, JSON.stringify(value.tokens))
        }),
      read: guarded(() => {
        const since = database.prepare("SELECT MIN(started_at) AS since FROM usage_attempts").get()?.since ?? null
        const totals = database
          .prepare(`SELECT category, model, COUNT(*) AS attempts,
        SUM(CASE WHEN json_extract(tokens,'$.input') IS NULL OR json_extract(tokens,'$.output') IS NULL OR json_extract(tokens,'$.cachedInput') IS NULL THEN 1 ELSE 0 END) AS unreported,
        SUM(json_extract(tokens,'$.input')) AS input, SUM(json_extract(tokens,'$.cachedInput')) AS cachedInput,
        SUM(json_extract(tokens,'$.output')) AS output, SUM(json_extract(tokens,'$.reasoningOutput')) AS reasoningOutput
        FROM usage_attempts GROUP BY category, model`)
          .all()
        const recent = database
          .prepare("SELECT * FROM usage_attempts ORDER BY started_at DESC, id DESC LIMIT 20")
          .all()
          .map((row) => ({
            id: row.id,
            category: row.category,
            model: row.model,
            startedAt: row.started_at,
            outcome: row.outcome,
            tokens: Schema.decodeUnknownSync(Schema.fromJsonString(UsageAttempt.fields.tokens))(row.tokens)
          }))
        return Schema.decodeUnknownSync(LedgerSnapshot)({ since, degraded, totals, recent })
      })
    })
  })
