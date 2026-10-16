import {
  type Change,
  type Entity,
  type EntityType,
  type KnowledgeRevision,
  type Relation,
  type RelationType,
  knowledgeLimits
} from "./models.ts"
import { reject, uniqueNames, validateValues } from "./validation.ts"

const validateRelationType = (type: RelationType, names: ReadonlySet<string>): void => {
  uniqueNames(type.sources, `Source kinds of ${type.name}`)
  uniqueNames(type.targets, `Target kinds of ${type.name}`)
  uniqueNames(
    type.fields.map((field) => field.name),
    `Fields of ${type.name}`
  )
  for (const name of [...type.sources, ...type.targets])
    if (!names.has(name)) reject("InvalidSchema", `Relation type ${type.name}: undeclared endpoint kind ${name}`)
}
const validateRelationTypes = (types: readonly RelationType[], entityTypes: readonly EntityType[]): void => {
  if (types.length > knowledgeLimits.relationTypes)
    reject("LimitExceeded", "The schema permits at most 64 relation types")
  uniqueNames(
    types.map((type) => type.name),
    "Relation types"
  )
  const names = new Set(entityTypes.map((type) => type.name))
  types.forEach((type) => validateRelationType(type, names))
}
const createRelations = (current: readonly Relation[], change: Change): Map<string, Relation> => {
  const relations = new Map(current.map((relation) => [relation.id, relation]))
  for (const relation of change.relationCreates ?? []) {
    if (relations.has(relation.id)) reject("IdentityConflict", `Relation ${relation.id} already exists or is repeated`)
    relations.set(relation.id, relation)
  }
  return relations
}
const updateRelations = (relations: Map<string, Relation>, change: Change): void => {
  const changed = new Set((change.relationCreates ?? []).map((relation) => relation.id))
  for (const update of change.relationUpdates ?? []) {
    if (changed.has(update.id)) reject("IdentityConflict", `Relation ${update.id} occurs more than once in the change`)
    const previous = relations.get(update.id)
    if (previous === undefined) reject("InvalidEntity", `Cannot update missing relation ${update.id}`)
    relations.set(update.id, { ...previous, source: update.source, target: update.target, values: update.values })
    changed.add(update.id)
  }
}
const validateEndpoints = (relation: Relation, type: RelationType, entities: ReadonlyMap<string, Entity>): void => {
  const source = entities.get(relation.source)
  const target = entities.get(relation.target)
  if (source === undefined)
    reject("InvalidEntity", `Relation ${relation.id}: missing source endpoint ${relation.source}`)
  if (target === undefined)
    reject("InvalidEntity", `Relation ${relation.id}: missing target endpoint ${relation.target}`)
  if (!type.sources.includes(source.type))
    reject("InvalidEntity", `Relation ${relation.id}: ${source.type} is not an allowed source kind for ${type.name}`)
  if (!type.targets.includes(target.type))
    reject("InvalidEntity", `Relation ${relation.id}: ${target.type} is not an allowed target kind for ${type.name}`)
}
const validateRelations = (
  relations: readonly Relation[],
  types: readonly RelationType[],
  entities: readonly Entity[]
): void => {
  if (relations.length > knowledgeLimits.relations) reject("LimitExceeded", "The store permits at most 10000 relations")
  const declared = new Map(types.map((type) => [type.name, type]))
  const endpoints = new Map(entities.map((entity) => [entity.id, entity]))
  for (const relation of relations) {
    if (endpoints.has(relation.id)) reject("IdentityConflict", `Identity ${relation.id} is already used by an entity`)
    const type = declared.get(relation.type)
    if (type === undefined)
      reject("InvalidEntity", `Relation ${relation.id}: undeclared relation type ${relation.type}`)
    validateValues(relation, type)
    validateEndpoints(relation, type, endpoints)
  }
}
export const applyRelations = (
  current: KnowledgeRevision,
  change: Change,
  entities: readonly Entity[],
  entityTypes: readonly EntityType[]
) => {
  const types = [...current.snapshot.schema.relations, ...(change.relationTypes ?? [])]
  validateRelationTypes(types, entityTypes)
  const relations = createRelations(current.relations, change)
  updateRelations(relations, change)
  const ordered = [...relations.values()].sort((left, right) => left.id.localeCompare(right.id))
  validateRelations(ordered, types, entities)
  return { types, relations: ordered }
}
