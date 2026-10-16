import { writeSync } from "node:fs"
import { Effect, Layer, Schema } from "effect"
import { SqliteMemoryStorage, sqliteStorageLayer } from "../src/memory/adapter.ts"
import {
  Change,
  DurableKnowledge,
  HostContext,
  PersonalKnowledge,
  durableKnowledgeLayer,
  personalKnowledgeLayer
} from "../src/personal-knowledge/index.ts"

const path = process.argv[2]
if (path === undefined) throw new Error("Missing fixture path")
const request = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ change: Change, context: HostContext }))
)(process.argv[3])
const resource = sqliteStorageLayer(path)
const durable = Layer.unwrap(
  Effect.gen(function* () {
    const { storage } = yield* SqliteMemoryStorage
    return durableKnowledgeLayer(storage.database)
  })
).pipe(Layer.provide(resource))
const lostAcknowledgement = Layer.effect(
  DurableKnowledge,
  Effect.gen(function* () {
    const store = yield* DurableKnowledge
    if (process.argv[4] === "before-commit") {
      const { storage } = yield* SqliteMemoryStorage
      storage.database.function("crash_before_commit", () => {
        writeSync(1, "knowledge-partial\n")
        Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0)
        return 0
      })
      storage.database.exec(
        "CREATE TEMP TRIGGER crash_before_commit AFTER INSERT ON personal_knowledge_revisions WHEN NEW.revision>0 BEGIN SELECT crash_before_commit(); END"
      )
    }
    return DurableKnowledge.of({
      ...store,
      commit: (change) =>
        store.commit(change).pipe(
          Effect.andThen(
            Effect.sync(() => {
              // Keep IPC alive while acknowledgement is withheld until the parent kills this process.
              process.channel?.ref()
              process.send?.("knowledge-committed")
            })
          ),
          Effect.andThen(Effect.never)
        )
    })
  })
).pipe(Layer.provide(Layer.merge(durable, resource)))
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const knowledge = yield* PersonalKnowledge
      yield* knowledge.apply(request.change, request.context)
    }).pipe(Effect.provide(personalKnowledgeLayer.pipe(Layer.provide(lostAcknowledgement))))
  )
)
