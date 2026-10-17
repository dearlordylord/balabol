import { Context, Effect, Layer } from "effect"
import { type DictionaryPage, type DictionaryQuery, type DictionaryRejected, DictionaryUnavailable } from "./models.ts"
export class Dictionary extends Context.Service<
  Dictionary,
  { lookup: (query: DictionaryQuery) => Effect.Effect<DictionaryPage, DictionaryRejected | DictionaryUnavailable> }
>()("balabol/dictionary") {}
export const unavailableDictionaryLayer = Layer.succeed(Dictionary, {
  lookup: () =>
    Effect.fail(new DictionaryUnavailable({ reason: "Disabled", message: "Local dictionary is not configured" }))
})
