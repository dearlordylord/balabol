import { Effect, Schema } from "effect"
import { AnswerEvent, AnswerFailed, type AnswerCapabilities } from "../answer-generation/index.ts"
import type { LanguageSpan } from "../language/index.ts"

const supportsSpans = (capabilities: AnswerCapabilities, spans: readonly LanguageSpan[]) =>
  spans.every((span) => capabilities.languages.includes(span.language))

export const validateAnswerLanguages = (
  capabilities: AnswerCapabilities,
  responseLanguage: string,
  spans: readonly LanguageSpan[]
) =>
  capabilities.languages.includes(responseLanguage) && supportsSpans(capabilities, spans)
    ? Effect.void
    : Effect.fail(new AnswerFailed({ message: "Accepted input requires an unsupported answer language" }))

export const parseAnswerEvent = (raw: unknown, capabilities: AnswerCapabilities) =>
  Schema.decodeUnknownEffect(AnswerEvent)(raw).pipe(
    Effect.mapError(() => new AnswerFailed({ message: "Invalid provider event" })),
    Effect.flatMap((event) =>
      event.kind === "Delta" && !supportsSpans(capabilities, event.languageSpans)
        ? Effect.fail(new AnswerFailed({ message: "Provider emitted an unsupported answer language" }))
        : Effect.succeed(event)
    )
  )
