import { realpathSync, existsSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { Checkpoint, MemoryRecord, Storage, StoredMemory, Summary } from "@firfi/unii"
import { Schema } from "effect"
import type { DeliveryPayload } from "./contracts.ts"
import { DeliveryId, MessageText, Position, Receipt } from "./contracts.ts"

const Address = Schema.Struct({ level: Schema.Int, index: Schema.Int })
const Record = Schema.Struct({ id: Schema.Int, kind: Schema.String, text: Schema.String, date: Schema.String })
const Node = Schema.Struct({ level: Schema.Int, index: Schema.Int, text: Schema.String })
const CheckpointSchema = Schema.Struct({
  version: Schema.Literal(1),
  cursor: Schema.Int,
  main: Schema.Array(Address),
  compaction: Schema.Array(Address),
  mainBatching: Schema.Boolean,
  compactionBatching: Schema.Boolean
})
const Payload = Schema.Struct({ payload: Schema.String })
const decodePayload = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, row: unknown): S["Type"] =>
  Schema.decodeUnknownSync(schema)(JSON.parse(Schema.decodeUnknownSync(Payload)(row).payload))
const ledgerPayload = { deliveryId: DeliveryId, text: MessageText }
const Ledger = Schema.Union([
  Schema.Struct({ ...ledgerPayload, firstId: Schema.Null, position: Schema.Null }),
  Schema.Struct({ ...ledgerPayload, firstId: Position, position: Position })
])
export type Ledger = typeof Ledger.Type

/** A second SQLite file holds only the OS-released writer lease, never durable data. */
export class SqliteStorage implements Storage {
  readonly database: DatabaseSync
  readonly lease: DatabaseSync
  #pending: DeliveryPayload | undefined
  #closed = false
  #opened = false
  constructor(requestedPath: string) {
    const absolute = resolve(requestedPath)
    const path = existsSync(absolute)
      ? realpathSync(absolute)
      : join(realpathSync(dirname(absolute)), basename(absolute))
    this.lease = new DatabaseSync(`${path}.writer`)
    try {
      this.lease.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE")
    } catch (error) {
      this.lease.close()
      throw error
    }
    try {
      this.database = new DatabaseSync(path)
      try {
        this.database.exec(
          "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON; CREATE TABLE IF NOT EXISTS records(id INTEGER PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS nodes(level INTEGER NOT NULL,idx INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(level,idx)); CREATE TABLE IF NOT EXISTS checkpoint(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS deliveries(deliveryId TEXT PRIMARY KEY,text TEXT NOT NULL,position INTEGER UNIQUE,firstId INTEGER,endExclusive INTEGER)"
        )
      } catch (error) {
        this.database.close()
        throw error
      }
    } catch (error) {
      this.lease.close()
      throw error
    }
  }
  transaction<A>(action: () => A): A {
    this.database.exec("BEGIN IMMEDIATE")
    try {
      const result = action()
      this.database.exec("COMMIT")
      return result
    } catch (error) {
      this.database.exec("ROLLBACK")
      throw error
    }
  }
  find(deliveryId: DeliveryPayload["deliveryId"]): Ledger | undefined {
    const row = this.database
      .prepare("SELECT deliveryId,text,position,firstId FROM deliveries WHERE deliveryId=?")
      .get(deliveryId)
    return row === undefined ? undefined : Schema.decodeUnknownSync(Ledger)(row)
  }
  prepare(input: DeliveryPayload): void {
    this.database
      .prepare("INSERT OR IGNORE INTO deliveries(deliveryId,text) VALUES(?,?)")
      .run(input.deliveryId, input.text)
    this.#pending = input
  }
  page(after: number | undefined, limit: number): readonly Receipt[] {
    const rows =
      after === undefined
        ? this.database
            .prepare(
              "SELECT deliveryId,text,position,firstId AS recordId FROM deliveries WHERE firstId IS NOT NULL ORDER BY position LIMIT ?"
            )
            .all(limit)
        : this.database
            .prepare(
              "SELECT deliveryId,text,position,firstId AS recordId FROM deliveries WHERE firstId IS NOT NULL AND position>? ORDER BY position LIMIT ?"
            )
            .all(after, limit)
    return Schema.decodeUnknownSync(Schema.Array(Receipt))(rows)
  }
  async open(): Promise<void> {
    if (this.#opened || this.#closed) throw new Error("Storage already opened or closed")
    this.#opened = true
  }
  async load(): Promise<StoredMemory> {
    const records = this.database
      .prepare("SELECT payload FROM records ORDER BY id")
      .all()
      .map((row) => decodePayload(Record, row))
    const nodes = this.database
      .prepare("SELECT payload FROM nodes ORDER BY level,idx")
      .all()
      .map((row) => decodePayload(Node, row))
    const checkpoint = this.database.prepare("SELECT payload FROM checkpoint WHERE id=1").get()
    const parsed = checkpoint === undefined ? null : decodePayload(CheckpointSchema, checkpoint)
    return {
      records,
      nodes,
      checkpoint: parsed === null ? null : { ...parsed, main: [...parsed.main], compaction: [...parsed.compaction] }
    }
  }
  async appendRecords(records: readonly MemoryRecord[]): Promise<void> {
    this.transaction(() => {
      const existing = Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Int }))(
        this.database.prepare("SELECT COUNT(*) AS count FROM records").get()
      )
      records.forEach((record, offset) => {
        if (record.id !== existing.count + offset) throw new Error("Noncontiguous raw batch")
        const parsed = Schema.decodeUnknownSync(Record)(record)
        this.database.prepare("INSERT INTO records(id,payload) VALUES(?,?)").run(parsed.id, JSON.stringify(parsed))
      })
      const first = records.at(0)
      if (this.#pending === undefined || first === undefined) throw new Error("Raw append lacks delivery intent")
      const linked = this.database
        .prepare(
          "UPDATE deliveries SET firstId=?,endExclusive=?,position=(SELECT COALESCE(MAX(position)+1,0) FROM deliveries) WHERE deliveryId=? AND firstId IS NULL"
        )
        .run(first.id, first.id + records.length, this.#pending.deliveryId)
      if (linked.changes !== 1) throw new Error("Raw batch requires exactly one unaccepted delivery")
    })
    this.#pending = undefined
  }
  async appendNode(node: Summary): Promise<void> {
    const parsed = Schema.decodeUnknownSync(Node)(node)
    this.database
      .prepare("INSERT INTO nodes(level,idx,payload) VALUES(?,?,?)")
      .run(parsed.level, parsed.index, JSON.stringify(parsed))
  }
  async checkpoint(value: Checkpoint): Promise<void> {
    const parsed = Schema.decodeUnknownSync(CheckpointSchema)(value)
    this.database.prepare("INSERT OR REPLACE INTO checkpoint(id,payload) VALUES(1,?)").run(JSON.stringify(parsed))
  }
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.database.close()
    this.lease.close()
  }
}
