import {
  type Entity,
  type EntityType,
  type Scalar,
  type KnowledgeRevision,
  type NeighborhoodPage,
  type NeighborhoodQuery,
  type Query,
  type QueryPage,
  type Relation,
  freezeKnowledge,
  knowledgeLimits
} from "./models.ts"
import { boundedKnowledge, reject } from "./validation.ts"

const validateFilters = (type: EntityType, filters: readonly [string, Scalar][]): void => {
  const fields = new Map(type.fields.map((field) => [field.name, field]))
  for (const [name, value] of filters) {
    const field = fields.get(name)
    if (field === undefined) reject("InvalidEntity", `Undeclared query field ${name} on ${type.name}`)
    if (typeof value !== field.kind) reject("InvalidEntity", `Query field ${name} requires ${field.kind}`)
  }
}
const validateWhere = (current: KnowledgeRevision, query: Query): void => {
  const type = current.snapshot.schema.types.find((type) => type.name === query.type)
  if (query.type !== undefined && type === undefined) reject("InvalidEntity", `Undeclared entity type ${query.type}`)
  const filters = Object.entries(query.where ?? {})
  if (filters.length === 0) return
  if (type === undefined) reject("InvalidEntity", "A nonempty field filter requires a declared entity type")
  validateFilters(type, filters)
}
const matchesQuery = (entity: Entity, query: Query): boolean =>
  (query.id === undefined || entity.id === query.id) &&
  (query.type === undefined || entity.type === query.type) &&
  (query.after === undefined || entity.id > query.after)
const matchesFields = (entity: Entity, query: Query): boolean =>
  Object.entries(query.where ?? {}).every(
    ([field, value]) => Object.hasOwn(entity.values, field) && entity.values[field] === value
  )
export const queryRevision = (current: KnowledgeRevision, query: Query): QueryPage => {
  validateWhere(current, query)
  const matches = current.entities
    .filter((entity) => matchesQuery(entity, query) && matchesFields(entity, query))
    .sort((left, right) => left.id.localeCompare(right.id))
  const entities = matches.slice(0, query.limit)
  const result: QueryPage = {
    ...current.snapshot,
    entities,
    nextAfter: matches.length > query.limit ? (entities[entities.length - 1]?.id ?? null) : null
  }
  boundedKnowledge(result, knowledgeLimits.queryBytes, "Query result")
  freezeKnowledge(result)
  return result
}
const adjacentEndpoints = (
  relation: Relation,
  frontier: ReadonlySet<string>,
  direction: NeighborhoodQuery["direction"]
): readonly string[] => {
  const endpoints: string[] = []
  if (direction !== "incoming" && frontier.has(relation.source)) endpoints.push(relation.target)
  if (direction !== "outgoing" && frontier.has(relation.target)) endpoints.push(relation.source)
  return endpoints
}
const allowedRelations = (current: KnowledgeRevision, query: NeighborhoodQuery): readonly Relation[] => {
  const declared = new Set(current.snapshot.schema.relations.map((type) => type.name))
  for (const name of query.relationTypes ?? [])
    if (!declared.has(name)) reject("InvalidEntity", `Undeclared neighborhood relation type ${name}`)
  return current.relations.filter(
    (relation) => query.relationTypes === undefined || query.relationTypes.includes(relation.type)
  )
}
const visitLevel = (
  relations: readonly Relation[],
  frontier: ReadonlySet<string>,
  query: NeighborhoodQuery,
  visited: Set<string>,
  selected: Map<string, Relation>
): Set<string> => {
  const next = new Set<string>()
  for (const relation of relations) {
    const endpoints = adjacentEndpoints(relation, frontier, query.direction)
    if (endpoints.length === 0) continue
    selected.set(relation.id, relation)
    for (const endpoint of endpoints) {
      if (visited.has(endpoint)) continue
      visited.add(endpoint)
      next.add(endpoint)
    }
  }
  return next
}
const neighborhoodEdges = (relations: readonly Relation[], query: NeighborhoodQuery): readonly Relation[] => {
  let frontier = new Set([query.id])
  const visited = new Set([query.id])
  const selected = new Map<string, Relation>()
  for (let depth = 0; depth < query.depth; depth++) frontier = visitLevel(relations, frontier, query, visited, selected)
  return [...selected.values()].sort((left, right) => left.id.localeCompare(right.id))
}
export const neighborhoodRevision = (current: KnowledgeRevision, query: NeighborhoodQuery): NeighborhoodPage => {
  const root = current.entities.find((entity) => entity.id === query.id)
  if (root === undefined) reject("InvalidEntity", `Neighborhood root ${query.id} does not exist`)
  const candidates = neighborhoodEdges(allowedRelations(current, query), query).filter(
    (relation) => query.after === undefined || relation.id > query.after
  )
  const relations = candidates.slice(0, query.limit)
  const ids = new Set([root.id, ...relations.flatMap((relation) => [relation.source, relation.target])])
  const entities = current.entities
    .filter((entity) => ids.has(entity.id))
    .sort((left, right) => left.id.localeCompare(right.id))
  const truncated = candidates.length > query.limit
  const result: NeighborhoodPage = {
    ...current.snapshot,
    root,
    entities,
    relations,
    nextAfter: truncated ? (relations[relations.length - 1]?.id ?? null) : null,
    truncated
  }
  boundedKnowledge(result, knowledgeLimits.queryBytes, "Neighborhood result")
  freezeKnowledge(result)
  return result
}
