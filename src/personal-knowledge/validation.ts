import { KnowledgeRejected, type Entity, type EntityType } from "./models.ts"

export function reject(code: KnowledgeRejected["code"], message: string): never {
  throw new KnowledgeRejected({ code, message })
}
export const boundedKnowledge = <A extends object>(value: A, maximum: number, label: string): A => {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > maximum)
    reject("LimitExceeded", `${label} exceeds ${maximum} UTF-8 bytes; request less data`)
  return value
}
export const uniqueNames = (names: readonly string[], label: string): void => {
  if (new Set(names).size !== names.length) reject("InvalidSchema", `${label} must have unique names`)
}
export const validateValues = (record: Entity, type: EntityType): void => {
  const fields = new Map(type.fields.map((field) => [field.name, field]))
  for (const [name, value] of Object.entries(record.values)) {
    const field = fields.get(name)
    if (field === undefined) reject("InvalidEntity", `Record ${record.id}: undeclared field ${name} on ${type.name}`)
    if (typeof value !== field.kind) reject("InvalidEntity", `Record ${record.id}: ${name} requires ${field.kind}`)
  }
  for (const field of type.fields)
    if (field.required && !Object.hasOwn(record.values, field.name))
      reject("InvalidEntity", `Record ${record.id}: required field ${field.name} is absent`)
}
