import { Schema } from "effect"
import {
  type DifferenceEntry,
  type DifferencePage,
  type DifferenceQuery,
  type Entity,
  type EntityType,
  type KnowledgeRevision,
  KnowledgeId,
  type Relation,
  type RevisionSummary,
  knowledgeLimits,
  freezeKnowledge
} from "./models.ts"
import { boundedKnowledge, reject } from "./validation.ts"

export const revisionSummary = (revision: KnowledgeRevision): RevisionSummary => ({
  revision: revision.snapshot.revision,
  reason: revision.receipt?.reason ?? null,
  context: revision.receipt?.context ?? null
})
const schemaChanges = <T extends EntityType>(before: readonly T[], after: readonly T[]) => {
  const previous = new Map(before.map((type) => [type.name, type]))
  const next = new Map(after.map((type) => [type.name, type]))
  return [...new Set([...previous.keys(), ...next.keys()])].sort().flatMap((name) => {
    const old = previous.get(name) ?? null
    const current = next.get(name) ?? null
    return JSON.stringify(old) === JSON.stringify(current) ? [] : [{ name, before: old, after: current }]
  })
}
const changedFields = (before: Entity | undefined, after: Entity | undefined): readonly string[] =>
  [...new Set([...Object.keys(before?.values ?? {}), ...Object.keys(after?.values ?? {})])]
    .sort()
    .filter((name) => before?.values[name] !== after?.values[name])
const recordChange = (before: Entity | undefined, after: Entity | undefined): "created" | "updated" | "deleted" =>
  before === undefined ? "created" : after === undefined ? "deleted" : "updated"
const recordChanges = <T extends Entity>(before: readonly T[], after: readonly T[]) => {
  const previous = new Map(before.map((record) => [record.id, record]))
  const next = new Map(after.map((record) => [record.id, record]))
  const records = new Map([...before, ...after].map((record) => [record.id, record]))
  return [...records.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((record) => ({ id: record.id, record, before: previous.get(record.id), after: next.get(record.id) }))
}
const entityChanges = (before: readonly Entity[], after: readonly Entity[]): readonly DifferenceEntry[] =>
  recordChanges(before, after).flatMap((pair) => {
    const record = pair.record
    const fields = changedFields(pair.before, pair.after)
    if (fields.length === 0 && pair.before?.type === pair.after?.type) return []
    return [
      {
        kind: "Entity",
        id: pair.id,
        type: record.type,
        change: recordChange(pair.before, pair.after),
        changedFields: fields
      }
    ]
  })
const sameEndpoints = (before: Relation | undefined, after: Relation | undefined): boolean => {
  if (before === undefined || after === undefined) return false
  return before.source === after.source && before.target === after.target
}
const relationChanges = (before: readonly Relation[], after: readonly Relation[]): readonly DifferenceEntry[] =>
  recordChanges(before, after).flatMap((pair) => {
    const record = pair.record
    const fields = changedFields(pair.before, pair.after)
    const endpointsChanged = !sameEndpoints(pair.before, pair.after)
    if (fields.length === 0 && !endpointsChanged && pair.before?.type === pair.after?.type) return []
    return [
      {
        kind: "Relation",
        id: pair.id,
        type: record.type,
        change: recordChange(pair.before, pair.after),
        changedFields: fields,
        endpointsChanged
      }
    ]
  })
const phases: readonly DifferenceEntry["kind"][] = ["EntityType", "RelationType", "Entity", "Relation"]
const cursorName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(knowledgeLimits.nameCharacters),
  Schema.isTrimmed()
)
const Cursor = Schema.Union([
  Schema.Tuple([Schema.Literals(["EntityType", "RelationType"]), cursorName]),
  Schema.Tuple([Schema.Literals(["Entity", "Relation"]), KnowledgeId])
])
const entryKey = (entry: DifferenceEntry): string => ("name" in entry ? entry.name : entry.id)
const encodeCursor = (entry: DifferenceEntry): string => JSON.stringify([entry.kind, entryKey(entry)])
const afterCursor = (entry: DifferenceEntry, cursor: typeof Cursor.Type): boolean => {
  const order = phases.indexOf(entry.kind) - phases.indexOf(cursor[0])
  return order === 0 ? entryKey(entry) > cursor[1] : order > 0
}
const parseCursor = (after: string | undefined): typeof Cursor.Type | undefined => {
  if (after === undefined) return undefined
  try {
    return Schema.decodeUnknownSync(Schema.fromJsonString(Cursor))(after)
  } catch {
    return reject("InvalidSchema", "Invalid difference cursor; use the returned nextAfter cursor")
  }
}
const pageFor = (
  from: RevisionSummary,
  to: RevisionSummary,
  changes: readonly DifferenceEntry[],
  hasMore: boolean
): DifferencePage => ({
  from,
  to,
  changes,
  nextAfter:
    hasMore && changes.length > 0
      ? encodeCursor(changes[changes.length - 1] ?? reject("InvalidSchema", "Missing difference cursor entry"))
      : null
})
const paginate = (
  from: RevisionSummary,
  to: RevisionSummary,
  entries: readonly DifferenceEntry[],
  limit: number
): DifferencePage => {
  const changes: DifferenceEntry[] = []
  for (const entry of entries.slice(0, limit)) {
    const proposed = pageFor(from, to, [...changes, entry], changes.length + 1 < entries.length)
    if (Buffer.byteLength(JSON.stringify(proposed), "utf8") > knowledgeLimits.queryBytes) {
      if (changes.length === 0) reject("LimitExceeded", "One difference entry exceeds the result byte limit")
      break
    }
    changes.push(entry)
  }
  return pageFor(from, to, changes, changes.length < entries.length)
}
export const differenceRevisions = (
  before: KnowledgeRevision,
  after: KnowledgeRevision,
  query: DifferenceQuery
): DifferencePage => {
  const entries: readonly DifferenceEntry[] = [
    ...schemaChanges(before.snapshot.schema.types, after.snapshot.schema.types).map(
      (change) => ({ kind: "EntityType", ...change }) satisfies DifferenceEntry
    ),
    ...schemaChanges(before.snapshot.schema.relations, after.snapshot.schema.relations).map(
      (change) => ({ kind: "RelationType", ...change }) satisfies DifferenceEntry
    ),
    ...entityChanges(before.entities, after.entities),
    ...relationChanges(before.relations, after.relations)
  ]
  const cursor = parseCursor(query.after)
  const remaining = cursor === undefined ? entries : entries.filter((entry) => afterCursor(entry, cursor))
  const page = paginate(revisionSummary(before), revisionSummary(after), remaining, query.limit)
  boundedKnowledge(page, knowledgeLimits.queryBytes, "Difference result")
  freezeKnowledge(page)
  return page
}
