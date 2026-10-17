// Read-only runtime entrypoint; explicit catalog preparation uses provision.ts.
export * from "./models.ts"
export { Dictionary, unavailableDictionaryLayer } from "./service.ts"
export { sqliteDictionaryLayer } from "./sqlite.ts"
