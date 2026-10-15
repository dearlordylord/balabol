import { AnswerGeneration, AnswerRequest, AnswerFailed } from "./contracts.ts"
import { Effect, Layer, Schema, Stream } from "effect"
import { LanguageTags } from "../language/index.ts"
export { AnswerGeneration, AnswerRequest, AnswerFailed, AnswerCapabilities, AnswerEvent } from "./contracts.ts"
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

export { subscriptionAnswerLayer } from "./subscription.ts"
