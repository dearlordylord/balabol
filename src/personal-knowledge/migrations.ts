import {
  type Entity,
  type EntityType,
  type Field,
  type KnowledgeRevision,
  type Migration,
  type Scalar,
  knowledgeLimits
} from "./models.ts"
import { reject } from "./validation.ts"

type AddField = Extract<Migration, { kind: "AddField" }>
const addedFields = (fields: readonly Field[], migration: AddField, hasRecords: boolean): readonly Field[] => {
  if (fields.some((field) => field.name === migration.field.name))
    reject("InvalidSchema", `Field ${migration.field.name} already exists on ${migration.type}`)
  if (fields.length >= knowledgeLimits.fieldsPerType)
    reject("LimitExceeded", "A type permits at most 32 declared fields")
  if (migration.default !== undefined && typeof migration.default !== migration.field.kind)
    reject("InvalidSchema", `Default for ${migration.field.name} requires ${migration.field.kind}`)
  if (migration.field.required && hasRecords && migration.default === undefined)
    reject("InvalidSchema", `Required field ${migration.field.name} needs a default for existing records`)
  return [...fields, migration.field]
}
const renamedFields = (
  fields: readonly Field[],
  migration: Extract<Migration, { kind: "RenameField" }>
): readonly Field[] => {
  if (!fields.some((field) => field.name === migration.from))
    reject("InvalidSchema", `Field ${migration.from} does not exist on ${migration.type}`)
  if (fields.some((field) => field.name === migration.to))
    reject("InvalidSchema", `Field ${migration.to} already exists on ${migration.type}`)
  return fields.map((field) => (field.name === migration.from ? { ...field, name: migration.to } : field))
}
const migrateValues = (
  values: Readonly<Record<string, Scalar>>,
  migration: Migration
): Readonly<Record<string, Scalar>> => {
  if (migration.kind === "AddField")
    return migration.default === undefined ? values : { ...values, [migration.field.name]: migration.default }
  if (!Object.hasOwn(values, migration.from)) return values
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name === migration.from ? migration.to : name, value])
  )
}
const migrateGroup = <T extends EntityType, R extends Entity>(
  types: readonly T[],
  records: readonly R[],
  migration: Migration
) => {
  const type = types.find((type) => type.name === migration.type)
  if (type === undefined)
    reject("InvalidSchema", `Cannot migrate undeclared ${migration.target} type ${migration.type}`)
  const affected = records.some((record) => record.type === migration.type)
  const fields =
    migration.kind === "AddField"
      ? addedFields(type.fields, migration, affected)
      : renamedFields(type.fields, migration)
  return {
    types: types.map((declared) => (declared.name === migration.type ? { ...declared, fields } : declared)),
    records: records.map((record) =>
      record.type === migration.type ? { ...record, values: migrateValues(record.values, migration) } : record
    )
  }
}
export const migrateRevision = (current: KnowledgeRevision, migrations: readonly Migration[]): KnowledgeRevision => {
  let result = current
  for (const migration of migrations) {
    if (migration.target === "entity") {
      const migrated = migrateGroup(result.snapshot.schema.types, result.entities, migration)
      result = {
        ...result,
        snapshot: { ...result.snapshot, schema: { ...result.snapshot.schema, types: migrated.types } },
        entities: migrated.records
      }
    } else {
      const migrated = migrateGroup(result.snapshot.schema.relations, result.relations, migration)
      result = {
        ...result,
        snapshot: { ...result.snapshot, schema: { ...result.snapshot.schema, relations: migrated.types } },
        relations: migrated.records
      }
    }
  }
  return result
}
