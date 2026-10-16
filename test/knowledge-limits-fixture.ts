import { Effect } from "effect"
import { SqliteMemoryStorage, sqliteStorageLayer } from "../src/memory/index.ts"
import {
  sqliteKnowledgeLayer,
  type PersonalKnowledge,
  type Change,
  type Entity
} from "../src/personal-knowledge/index.ts"

const inputDeliveryId = "11111111-1111-4111-8111-111111111111"
const responseId = "22222222-2222-4222-8222-222222222222"
export const context = (operationId: string) => ({ inputDeliveryId, responseId, operationId })
const hexadecimalRadix = 16
const identitySuffixLength = 12
export const identity = (index: number) =>
  `aaaaaaaa-aaaa-4aaa-8aaa-${index.toString(hexadecimalRadix).padStart(identitySuffixLength, "0")}`
export const entities = (start: number, count: number, size: number): readonly Entity[] =>
  Array.from({ length: count }, (_, offset) => ({
    id: identity(start + offset),
    type: "Entry",
    values: { text: "x".repeat(size) }
  }))
export const creation = (creates: readonly Entity[]): Change => ({
  reason: "Retain bounded structured values",
  types: [],
  creates,
  updates: []
})
export const declaration: Change = {
  reason: "Declare entries",
  types: [{ name: "Entry", fields: [{ name: "text", kind: "string", required: true }] }],
  creates: [],
  updates: []
}
export const opened = <A, E>(path: string, program: Effect.Effect<A, E, PersonalKnowledge>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { storage } = yield* SqliteMemoryStorage
        return yield* program.pipe(Effect.provide(sqliteKnowledgeLayer(storage.database)))
      }).pipe(Effect.provide(sqliteStorageLayer(path)))
    )
  )
