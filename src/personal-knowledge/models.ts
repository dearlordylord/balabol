import { Effect, Schema, SchemaGetter } from "effect"

const changeKiB = 128
const stateMiB = 4
const responseKiB = 256
const kibibyte = 1024

export const knowledgeLimits = Object.freeze({
  types: 64,
  fieldsPerType: 32,
  entities: 10_000,
  relationTypes: 64,
  relations: 10_000,
  batchEntries: 100,
  nameCharacters: 128,
  stringCharacters: 4096,
  reasonCharacters: 1024,
  operationCharacters: 256,
  changeBytes: changeKiB * kibibyte,
  stateBytes: stateMiB * kibibyte * kibibyte,
  queryBytes: responseKiB * kibibyte,
  queryEntities: 100,
  neighborhoodEntities: 201,
  neighborhoodDepth: 2,
  receiptCount: 20,
  receiptBytes: responseKiB * kibibyte
})
export const KnowledgeId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.decodeTo(Schema.String.check(Schema.isUUID(), Schema.isLowercased()), {
    decode: SchemaGetter.transform((id) => id.toLowerCase()),
    encode: SchemaGetter.passthrough()
  })
)
const Name = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(knowledgeLimits.nameCharacters),
  Schema.isTrimmed()
)
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const Scalar = Schema.Union([
  Schema.String.check(Schema.isMaxLength(knowledgeLimits.stringCharacters)),
  Schema.Number.check(Schema.isFinite()),
  Schema.Boolean
])
export type Scalar = typeof Scalar.Type
export const Field = Schema.Struct({
  name: Name,
  kind: Schema.Literals(["string", "number", "boolean"]),
  required: Schema.Boolean
})
export type Field = typeof Field.Type
export const EntityType = Schema.Struct({
  name: Name,
  fields: Schema.Array(Field).check(Schema.isMaxLength(knowledgeLimits.fieldsPerType))
})
export type EntityType = typeof EntityType.Type
export const Values = Schema.Record(Name, Scalar)
export const Entity = Schema.Struct({ id: KnowledgeId, type: Name, values: Values })
export type Entity = typeof Entity.Type
export const RelationType = Schema.Struct({
  name: Name,
  sources: Schema.Array(Name).check(Schema.isMinLength(1), Schema.isMaxLength(knowledgeLimits.types)),
  targets: Schema.Array(Name).check(Schema.isMinLength(1), Schema.isMaxLength(knowledgeLimits.types)),
  fields: Schema.Array(Field).check(Schema.isMaxLength(knowledgeLimits.fieldsPerType))
})
export type RelationType = typeof RelationType.Type
export const Relation = Schema.Struct({
  id: KnowledgeId,
  type: Name,
  source: KnowledgeId,
  target: KnowledgeId,
  values: Values
})
export type Relation = typeof Relation.Type
export const KnowledgeSchema = Schema.Struct({
  types: Schema.Array(EntityType).check(Schema.isMaxLength(knowledgeLimits.types)),
  relations: Schema.Array(RelationType).check(Schema.isMaxLength(knowledgeLimits.relationTypes))
})
export type KnowledgeSchema = typeof KnowledgeSchema.Type
export const KnowledgeSnapshot = Schema.Struct({ revision: Revision, schema: KnowledgeSchema })
export type KnowledgeSnapshot = typeof KnowledgeSnapshot.Type
export const Change = Schema.Struct({
  reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(knowledgeLimits.reasonCharacters)),
  types: Schema.Array(EntityType).check(Schema.isMaxLength(knowledgeLimits.batchEntries)),
  creates: Schema.Array(Entity).check(Schema.isMaxLength(knowledgeLimits.batchEntries)),
  updates: Schema.Array(Schema.Struct({ id: KnowledgeId, values: Values })).check(
    Schema.isMaxLength(knowledgeLimits.batchEntries)
  ),
  relationTypes: Schema.optionalKey(Schema.Array(RelationType).check(Schema.isMaxLength(knowledgeLimits.batchEntries))),
  relationCreates: Schema.optionalKey(Schema.Array(Relation).check(Schema.isMaxLength(knowledgeLimits.batchEntries))),
  relationUpdates: Schema.optionalKey(
    Schema.Array(Schema.Struct({ id: KnowledgeId, source: KnowledgeId, target: KnowledgeId, values: Values })).check(
      Schema.isMaxLength(knowledgeLimits.batchEntries)
    )
  )
})
export type Change = typeof Change.Type
export const OperationIdentity = Schema.Struct({
  inputDeliveryId: KnowledgeId,
  operationId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(knowledgeLimits.operationCharacters))
})
export type OperationIdentity = typeof OperationIdentity.Type
export const HostContext = Schema.Struct({ ...OperationIdentity.fields, responseId: KnowledgeId })
export type HostContext = typeof HostContext.Type
export const KnowledgeReceipt = Schema.Struct({
  context: HostContext,
  revision: Revision,
  reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(knowledgeLimits.reasonCharacters)),
  createdIds: Schema.Array(KnowledgeId).check(Schema.isMaxLength(knowledgeLimits.batchEntries)),
  updatedIds: Schema.Array(KnowledgeId).check(Schema.isMaxLength(knowledgeLimits.batchEntries)),
  createdRelationIds: Schema.Array(KnowledgeId)
    .check(Schema.isMaxLength(knowledgeLimits.batchEntries))
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  updatedRelationIds: Schema.Array(KnowledgeId)
    .check(Schema.isMaxLength(knowledgeLimits.batchEntries))
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed([])))
})
export type KnowledgeReceipt = typeof KnowledgeReceipt.Type
export const KnowledgeRevision = Schema.Struct({
  snapshot: KnowledgeSnapshot,
  entities: Schema.Array(Entity).check(Schema.isMaxLength(knowledgeLimits.entities)),
  relations: Schema.Array(Relation)
    .check(Schema.isMaxLength(knowledgeLimits.relations))
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  receipt: Schema.NullOr(KnowledgeReceipt)
})
export type KnowledgeRevision = typeof KnowledgeRevision.Type
export const Query = Schema.Struct({
  id: Schema.optionalKey(KnowledgeId),
  type: Schema.optionalKey(Name),
  after: Schema.optionalKey(KnowledgeId),
  where: Schema.optionalKey(Values),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: knowledgeLimits.queryEntities }))
})
export type Query = typeof Query.Type
export const QueryPage = Schema.Struct({
  ...KnowledgeSnapshot.fields,
  entities: Schema.Array(Entity).check(Schema.isMaxLength(knowledgeLimits.queryEntities)),
  nextAfter: Schema.NullOr(KnowledgeId)
})
export type QueryPage = typeof QueryPage.Type
export const NeighborhoodQuery = Schema.Struct({
  id: KnowledgeId,
  depth: Schema.Literals([1, knowledgeLimits.neighborhoodDepth]),
  direction: Schema.Literals(["outgoing", "incoming", "both"]),
  relationTypes: Schema.optionalKey(Schema.Array(Name).check(Schema.isMaxLength(knowledgeLimits.relationTypes))),
  after: Schema.optionalKey(KnowledgeId),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: knowledgeLimits.queryEntities }))
})
export type NeighborhoodQuery = typeof NeighborhoodQuery.Type
export const NeighborhoodPage = Schema.Struct({
  ...KnowledgeSnapshot.fields,
  root: Entity,
  entities: Schema.Array(Entity).check(Schema.isMaxLength(knowledgeLimits.neighborhoodEntities)),
  relations: Schema.Array(Relation).check(Schema.isMaxLength(knowledgeLimits.queryEntities)),
  nextAfter: Schema.NullOr(KnowledgeId),
  truncated: Schema.Boolean
})
export type NeighborhoodPage = typeof NeighborhoodPage.Type
export const ReceiptQuery = Schema.Struct({
  inputDeliveryId: KnowledgeId,
  afterRevision: Schema.optionalKey(Revision),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: knowledgeLimits.receiptCount }))
})
export type ReceiptQuery = typeof ReceiptQuery.Type
export const ReceiptPage = Schema.Struct({
  receipts: Schema.Array(KnowledgeReceipt).check(Schema.isMaxLength(knowledgeLimits.receiptCount)),
  nextAfterRevision: Schema.NullOr(Revision)
})
export type ReceiptPage = typeof ReceiptPage.Type
export const StoredOutcome = Schema.Struct({ change: Change, receipt: KnowledgeReceipt })
export type StoredOutcome = typeof StoredOutcome.Type
export const CommitRequest = Schema.Struct({ expectedRevision: Revision, revision: KnowledgeRevision, change: Change })
export type CommitRequest = typeof CommitRequest.Type
export class KnowledgeUnavailable extends Schema.TaggedError<KnowledgeUnavailable>()("KnowledgeUnavailable", {
  message: Schema.String
}) {}
export class KnowledgeRejected extends Schema.TaggedError<KnowledgeRejected>()("KnowledgeRejected", {
  code: Schema.Literals(["InvalidSchema", "InvalidEntity", "IdentityConflict", "LimitExceeded", "RevisionNotFound"]),
  message: Schema.String
}) {}

/** Canonical values make JSON object key order irrelevant to operation redelivery. */
const orderedValues = <A extends { readonly values: typeof Values.Type }>(record: A) => ({
  ...record,
  values: Object.fromEntries(Object.entries(record.values).sort(([left], [right]) => left.localeCompare(right)))
})
const nonempty = <A>(key: string, values: readonly A[] | undefined) =>
  values === undefined || values.length === 0 ? {} : { [key]: values }
export const changeIdentity = (change: Change): string =>
  JSON.stringify({
    reason: change.reason,
    types: change.types,
    creates: change.creates.map(orderedValues),
    updates: change.updates.map(orderedValues),
    ...nonempty("relationTypes", change.relationTypes),
    ...nonempty("relationCreates", change.relationCreates?.map(orderedValues)),
    ...nonempty("relationUpdates", change.relationUpdates?.map(orderedValues))
  })

export const freezeKnowledge = (value: unknown): void => {
  if (typeof value !== "object" || value === null) return
  Object.values(value).forEach(freezeKnowledge)
  Object.freeze(value)
}
