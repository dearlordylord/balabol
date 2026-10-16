import type { Stream } from "effect"
import { Context, Schema } from "effect"
import { LanguageTag, LanguageTags, LanguageSpans, validLanguageSpans } from "../language/index.ts"
const modelNameLimit = 200
const priorContextLimit = 1000000
const answerTextLimit = 100000
export const AnswerCapabilities = Schema.Struct({ languages: LanguageTags, output: Schema.Literal("text-deltas") })
export type AnswerCapabilities = typeof AnswerCapabilities.Type
// Complete current input remains separate from exclusive prior memory context.
export const AnswerRequest = Schema.Struct({
  inputDeliveryId: Schema.String.check(Schema.isUUID()),
  responseId: Schema.String.check(Schema.isUUID()),
  model: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(modelNameLimit)),
  prior: Schema.String.check(Schema.isMaxLength(priorContextLimit)),
  input: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(answerTextLimit)),
  inputLanguageSpans: LanguageSpans,
  responseLanguage: LanguageTag,
  capabilities: Schema.Array(Schema.Literal("memory.context")).check(Schema.isMaxLength(1))
}).check(Schema.makeFilter((request) => validLanguageSpans(request.input, request.inputLanguageSpans)))
export type AnswerRequest = typeof AnswerRequest.Type
export const AnswerEvent = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("Delta"),
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(answerTextLimit)),
    languageSpans: LanguageSpans
  }).check(Schema.makeFilter((event) => validLanguageSpans(event.text, event.languageSpans))),
  Schema.Struct({ kind: Schema.Literal("Completed") })
])
export type AnswerEvent = typeof AnswerEvent.Type
export class AnswerFailed extends Schema.TaggedError<AnswerFailed>()("AnswerFailed", { message: Schema.String }) {}
export class AnswerGeneration extends Context.Service<
  AnswerGeneration,
  { capabilities: AnswerCapabilities; generate: (request: AnswerRequest) => Stream.Stream<AnswerEvent, AnswerFailed> }
>()("balabol/answer-generation") {}
