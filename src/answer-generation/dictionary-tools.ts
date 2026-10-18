import { withAuditSpan } from "../operation-audit/index.ts"
import { Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import {
  DictionaryQuery,
  DictionaryPage,
  DictionaryRejected,
  DictionaryUnavailable,
  type Dictionary
} from "../dictionary/index.ts"

export const dictionaryTools = Toolkit.make(
  Tool.make("lookup_dictionary", {
    description:
      "Look up a word or inflected form in the local Wiktionary catalog by language and spelling. Supports ru, fr and en with English definitions. Spelling is case-sensitive and preserves accents. Returns bounded senses, etymology, forms and related words with source attribution. Follow nextOffset when needed. This read never changes personal knowledge; absence of an etymology is not evidence of a relationship.",
    parameters: DictionaryQuery.annotate({ parseOptions: { onExcessProperty: "error" as const } }),
    success: DictionaryPage,
    failure: Schema.Union([DictionaryRejected, DictionaryUnavailable]),
    failureMode: "return"
  }).annotate(Tool.Strict, false)
)

export const dictionaryHandlers = (dictionary: typeof Dictionary.Service, responseId?: string) =>
  dictionaryTools.toLayer({
    lookup_dictionary: (query) =>
      dictionary.lookup(query).pipe(withAuditSpan("agent.tool", responseId, { tool: "lookup_dictionary" }))
  })
