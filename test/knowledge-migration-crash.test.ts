import { fork } from "node:child_process"
import { once } from "node:events"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { expect, it } from "vitest"
import { SqliteMemoryStorage, sqliteStorageLayer } from "../src/memory/index.ts"
import { PersonalKnowledge, sqliteKnowledgeLayer, type Change } from "../src/personal-knowledge/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"

const entityId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const relationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const context = {
  inputDeliveryId: "11111111-1111-4111-8111-111111111111",
  responseId: "22222222-2222-4222-8222-222222222222",
  operationId: "original"
}
const initial: Change = {
  reason: "Keep the original field names",
  types: [{ name: "Expression", fields: [{ name: "text", kind: "string", required: true }] }],
  creates: [{ id: entityId, type: "Expression", values: { text: "pain" } }],
  updates: [],
  relationTypes: [
    {
      name: "Cue",
      sources: ["Expression"],
      targets: ["Expression"],
      fields: [{ name: "text", kind: "string", required: true }]
    }
  ],
  relationCreates: [{ id: relationId, type: "Cue", source: entityId, target: entityId, values: { text: "Paris" } }]
}
const migration: Change = {
  reason: "Rename entity and relation fields atomically",
  types: [],
  creates: [],
  updates: [],
  migrations: [
    { kind: "RenameField", target: "entity", type: "Expression", from: "text", to: "word" },
    { kind: "RenameField", target: "relation", type: "Cue", from: "text", to: "hint" }
  ]
}
const opened = <A, E>(path: string, program: Effect.Effect<A, E, PersonalKnowledge>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { storage } = yield* SqliteMemoryStorage
        return yield* program.pipe(Effect.provide(sqliteKnowledgeLayer(storage.database)))
      }).pipe(Effect.provide(sqliteStorageLayer(path)))
    )
  )

it("process death after a migration history insert preserves the complete preceding schema/data and receipt", async () => {
  const database = await temporaryDatabase()
  const original = await opened(
    database.path,
    Effect.gen(function* () {
      const knowledge = yield* PersonalKnowledge
      yield* knowledge.apply(initial, context)
      return yield* knowledge.revision(1)
    })
  )
  const migrationContext = { ...context, operationId: "rename" }
  const child = fork(
    fileURLToPath(new URL("./knowledge-crash-child.ts", import.meta.url)),
    [database.path, JSON.stringify({ change: migration, context: migrationContext }), "before-commit"],
    { execArgv: ["--experimental-strip-types"], stdio: ["ignore", "pipe", "pipe", "ipc"] }
  )
  try {
    if (child.stdout === null) throw new Error("Missing crash marker stream")
    const [marker] = await Promise.race([
      once(child.stdout, "data"),
      once(child, "exit").then(([code]) => {
        throw new Error(`Migration process exited before gate: ${String(code)}`)
      })
    ])
    expect(String(marker)).toBe("knowledge-partial\n")
    const exited = once(child, "exit")
    child.kill("SIGKILL")
    await exited
    await opened(
      database.path,
      Effect.gen(function* () {
        const knowledge = yield* PersonalKnowledge
        expect(yield* knowledge.revision(1)).toEqual(original)
        expect((yield* knowledge.inspect()).revision).toBe(1)
        expect(yield* knowledge.revision(2).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { code: "RevisionNotFound" }
        })
        expect((yield* knowledge.receipts({ inputDeliveryId: context.inputDeliveryId, limit: 20 })).receipts).toEqual([
          original.receipt
        ])
        expect((yield* knowledge.apply(migration, migrationContext)).revision).toBe(2)
        const migrated = yield* knowledge.neighborhood({ id: entityId, depth: 1, direction: "both", limit: 10 })
        expect(migrated.root.values).toEqual({ word: "pain" })
        expect(migrated.relations[0]?.values).toEqual({ hint: "Paris" })
        expect(yield* knowledge.revision(1)).toEqual(original)
      })
    )
  } finally {
    child.kill("SIGKILL")
    await database.close()
  }
})
