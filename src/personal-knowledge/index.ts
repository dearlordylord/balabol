import type { DatabaseSync } from "node:sqlite"
import { Layer } from "effect"
import { personalKnowledgeLayer } from "./service.ts"
import { durableKnowledgeLayer } from "./sqlite.ts"

export * from "./models.ts"
export { DurableKnowledge } from "./durable-port.ts"
export { PersonalKnowledge, personalKnowledgeLayer } from "./service.ts"
export { durableKnowledgeLayer } from "./sqlite.ts"

/** Composition owns the borrowed database's acquisition, durability configuration and release. */
export const sqliteKnowledgeLayer = (database: DatabaseSync) =>
  personalKnowledgeLayer.pipe(Layer.provide(durableKnowledgeLayer(database)))
