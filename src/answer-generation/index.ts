import { Context, Effect, Layer, Schema, Stream } from "effect"
import { LanguageTag, LanguageTags, LanguageSpans, validLanguageSpans } from "../language/index.ts"
const modelNameLimit = 200
const priorContextLimit = 1000000
const answerTextLimit = 100000
const maximumDelayMillis = 60000
const defaultDelayMillis = 80
const deltaCharacters = 24
const fixtureLanguages = ["ru", "fr", "en", "ja"]
const localizedReplies: Readonly<Record<string, string>> = {
  ru: "Это демонстрационный ответ.",
  fr: "Ceci est une réponse fictive.",
  en: "This is a fixture reply.",
  ja: "これはデモの返答です。"
}
export const AnswerCapabilities = Schema.Struct({ languages: LanguageTags, output: Schema.Literal("text-deltas") })
export type AnswerCapabilities = typeof AnswerCapabilities.Type
// Complete current input remains separate from exclusive prior memory context.
export const AnswerRequest = Schema.Struct({
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
const Configuration = Schema.Struct({
  delayMillis: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(maximumDelayMillis)),
  languages: LanguageTags
}).check(Schema.makeFilter((config) => config.languages.every((language) => fixtureLanguages.includes(language))))
const failed = (message: string) => new AnswerFailed({ message })
const chunks = (text: string) =>
  Array.from(text).reduce<string[]>((parts, character) => {
    const last = parts[parts.length - 1]
    if (last === undefined || last.length + character.length > deltaCharacters) parts.push(character)
    else parts[parts.length - 1] = last + character
    return parts
  }, [])
const reply = (request: AnswerRequest, delayMillis: number) => {
  const text = localizedReplies[request.responseLanguage]
  if (text === undefined) return Stream.fail(failed("Unsupported fixture response language"))
  return Stream.fromIterable(chunks(text)).pipe(
    Stream.mapEffect((text) =>
      Effect.sleep(delayMillis).pipe(
        Effect.as({
          kind: "Delta" as const,
          text,
          languageSpans: [{ language: request.responseLanguage, start: 0, end: text.length }]
        })
      )
    ),
    Stream.concat(Stream.succeed({ kind: "Completed" as const }))
  )
}
export const fakeAnswerLayer = (
  delayMillis = defaultDelayMillis,
  languages: readonly string[] = ["ru", "fr", "en", "ja"]
) =>
  Layer.effect(
    AnswerGeneration,
    Schema.decodeUnknownEffect(Configuration)({ delayMillis, languages }).pipe(
      Effect.mapError(() => failed("Invalid fake answer language configuration or delay")),
      Effect.map((config) =>
        AnswerGeneration.of({
          capabilities: { languages: config.languages, output: "text-deltas" },
          generate: (raw) =>
            Stream.unwrap(
              Schema.decodeUnknownEffect(AnswerRequest)(raw).pipe(
                Effect.mapError(() => failed("Invalid answer request or capability")),
                Effect.flatMap((request) =>
                  config.languages.includes(request.responseLanguage) &&
                  request.inputLanguageSpans.every((span) => config.languages.includes(span.language))
                    ? Effect.succeed(reply(request, config.delayMillis))
                    : Effect.fail(failed("Unsupported answer language"))
                )
              )
            )
        })
      )
    )
  )
