import { Schema } from "effect"
import {
  Change,
  KnowledgeRejected,
  KnowledgeRevision,
  changeIdentity,
  freezeKnowledge,
  knowledgeLimits,
  type Entity,
  type EntityType,
  type HostContext,
  type KnowledgeReceipt
} from "./models.ts"
import { applyRelations } from "./relations.ts"
import { boundedKnowledge, reject, uniqueNames, validateValues } from "./validation.ts"
export { boundedKnowledge } from "./validation.ts"

const maximumErrorCharacters = 512
const entryCount = (entries: readonly unknown[] | undefined): number => entries?.length ?? 0

export const parseChange = (change: Change): Change => {
  boundedKnowledge(change, knowledgeLimits.changeBytes, "Change")
  const count =
    change.types.length +
    change.creates.length +
    change.updates.length +
    entryCount(change.relationTypes) +
    entryCount(change.relationCreates) +
    entryCount(change.relationUpdates)
  if (count === 0) reject("InvalidEntity", "A change must introduce a type, create an entity or update an entity")
  if (count > knowledgeLimits.batchEntries) reject("LimitExceeded", "A change permits at most 100 total entries")
  if (
    [...change.types, ...(change.relationTypes ?? [])].some(
      (type) => type.fields.length > knowledgeLimits.fieldsPerType
    )
  )
    reject("LimitExceeded", "A type permits at most 32 declared fields")
  return Schema.decodeUnknownSync(Change, { onExcessProperty: "error" })(change)
}
const validateTypes = (types: readonly EntityType[]): void => {
  if (types.length > knowledgeLimits.types) reject("LimitExceeded", "The schema permits at most 64 entity types")
  uniqueNames(
    types.map((type) => type.name),
    "Entity types"
  )
  types.forEach((type) =>
    uniqueNames(
      type.fields.map((field) => field.name),
      `Fields of ${type.name}`
    )
  )
}
const validateEntities = (entities: readonly Entity[], types: readonly EntityType[]): void => {
  if (entities.length > knowledgeLimits.entities) reject("LimitExceeded", "The store permits at most 10000 entities")
  const declared = new Map(types.map((type) => [type.name, type]))
  for (const entity of entities) {
    const type = declared.get(entity.type)
    if (type === undefined) reject("InvalidEntity", `Entity ${entity.id}: undeclared type ${entity.type}`)
    validateValues(entity, type)
  }
}
const createEntities = (current: readonly Entity[], creates: readonly Entity[]): Map<string, Entity> => {
  const entities = new Map(current.map((entity) => [entity.id, entity]))
  for (const entity of creates) {
    if (entities.has(entity.id)) reject("IdentityConflict", `Entity ${entity.id} already exists or is repeated`)
    entities.set(entity.id, entity)
  }
  return entities
}
const updateEntities = (entities: Map<string, Entity>, change: Change): void => {
  const changed = new Set(change.creates.map((entity) => entity.id))
  for (const update of change.updates) {
    if (changed.has(update.id)) reject("IdentityConflict", `Entity ${update.id} occurs more than once in the change`)
    const previous = entities.get(update.id)
    if (previous === undefined) reject("InvalidEntity", `Cannot update missing entity ${update.id}`)
    entities.set(update.id, { ...previous, values: update.values })
    changed.add(update.id)
  }
}
export const nextRevision = (current: KnowledgeRevision, change: Change, context: HostContext): KnowledgeRevision => {
  const types = [...current.snapshot.schema.types, ...change.types]
  validateTypes(types)
  const entities = createEntities(current.entities, change.creates)
  updateEntities(entities, change)
  const ordered = [...entities.values()].sort((left, right) => left.id.localeCompare(right.id))
  validateEntities(ordered, types)
  const associations = applyRelations(current, change, ordered, types)
  const revision = current.snapshot.revision + 1
  const receipt: KnowledgeReceipt = {
    context,
    revision,
    reason: change.reason,
    createdIds: change.creates.map((entity) => entity.id),
    updatedIds: change.updates.map((entity) => entity.id),
    createdRelationIds: (change.relationCreates ?? []).map((relation) => relation.id),
    updatedRelationIds: (change.relationUpdates ?? []).map((relation) => relation.id)
  }
  const candidate = Schema.decodeUnknownSync(KnowledgeRevision)({
    snapshot: { revision, schema: { types, relations: associations.types } },
    entities: ordered,
    relations: associations.relations,
    receipt
  })
  boundedKnowledge(candidate, knowledgeLimits.stateBytes, "Knowledge revision")
  freezeKnowledge(candidate)
  return candidate
}
export const recoverOutcome = (previous: Change, proposed: Change, receipt: KnowledgeReceipt): KnowledgeReceipt => {
  if (changeIdentity(previous) !== changeIdentity(proposed))
    reject("IdentityConflict", "This accepted input and operation identity already refer to a different change")
  return receipt
}
export const rejectUnknown = (cause: unknown): KnowledgeRejected =>
  cause instanceof KnowledgeRejected
    ? cause
    : new KnowledgeRejected({
        code: "InvalidSchema",
        message: `Invalid knowledge request: ${String(cause).slice(0, maximumErrorCharacters)}`
      })
