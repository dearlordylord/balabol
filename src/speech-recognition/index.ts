import { Context, Effect, Layer, Schema, Stream } from "effect"

const MAX_LANGUAGES = 4
const SAMPLE_RATE_HZ = 16000
const MAX_SAMPLE_FRAMES = 240000
const BYTES_PER_SAMPLE = 2
const MAX_TEXT_LENGTH = 100000
const MAX_SPANS = 1000
const MAX_SCRIPT_EVENTS = 100
const MAX_DELAY_MILLIS = 60000
const MAX_FAILURE_LENGTH = 1000
const MAX_SCRIPTS = 100
const LAST_INDEX = -1

export const RecognitionLanguage = Schema.Literals(["ru", "fr", "en", "ja"])
export type RecognitionLanguage = typeof RecognitionLanguage.Type
const Languages = Schema.Array(RecognitionLanguage).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_LANGUAGES),
  Schema.isUnique()
)
const Offset = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const RecognitionAudio = Schema.Struct({
  encoding: Schema.Literal("pcm-s16le"),
  sampleRateHz: Schema.Literal(SAMPLE_RATE_HZ),
  channels: Schema.Literal(1),
  sampleFrames: Offset.check(Schema.isLessThanOrEqualTo(MAX_SAMPLE_FRAMES)),
  bytes: Schema.Uint8Array
}).check(Schema.makeFilter((audio) => audio.bytes.byteLength === audio.sampleFrames * BYTES_PER_SAMPLE))
export type RecognitionAudio = typeof RecognitionAudio.Type
export const RecognitionRequest = Schema.Struct({
  utteranceId: Schema.String.check(Schema.isUUID()),
  audio: RecognitionAudio,
  allowedLanguages: Languages
})
export type RecognitionRequest = typeof RecognitionRequest.Type
const Text = Schema.String.check(Schema.isMaxLength(MAX_TEXT_LENGTH))
const Span = Schema.Struct({ language: RecognitionLanguage, start: Offset, end: Offset })
const Hypothesis = Schema.Struct({ kind: Schema.Literal("Interim"), text: Text })
const Final = Schema.Struct({
  kind: Schema.Literal("Final"),
  text: Text,
  spans: Schema.Array(Span).check(Schema.isMaxLength(MAX_SPANS))
}).check(
  Schema.makeFilter((event) =>
    event.spans.every(
      (span, index) =>
        span.start < span.end && span.end <= event.text.length && span.start >= (event.spans[index - 1]?.end ?? 0)
    )
  )
)
const ScriptEvent = Schema.Union([Hypothesis, Final])
export type RecognitionScriptEvent = typeof ScriptEvent.Type
export const RecognitionEvent = Schema.Union([
  Schema.Struct({ utteranceId: RecognitionRequest.fields.utteranceId, ...Hypothesis.fields }),
  Schema.Struct({
    utteranceId: RecognitionRequest.fields.utteranceId,
    kind: Schema.Literal("Final"),
    text: Text,
    spans: Final.fields.spans
  }).check(Schema.makeFilter((event) => Schema.is(Final)(event)))
])
export type RecognitionEvent = typeof RecognitionEvent.Type
export class RecognitionFailed extends Schema.TaggedError<RecognitionFailed>()("RecognitionFailed", {
  message: Schema.String
}) {}
export const RecognitionCapabilities = Schema.Struct({
  input: Schema.Literal("supplied-audio"),
  languages: Languages,
  encoding: Schema.Literal("pcm-s16le"),
  sampleRateHz: Schema.Literal(SAMPLE_RATE_HZ),
  channels: Schema.Literal(1),
  maximumSampleFrames: Schema.Literal(MAX_SAMPLE_FRAMES)
})
export type RecognitionCapabilities = typeof RecognitionCapabilities.Type
// Grounding: research/local-speech.md, mlx_audio/stt/models/qwen3_asr/qwen3_asr.py.
// MLX accepts complete supplied audio; scripted Interim events do not promise incoming streaming.
// UTF-16 spans annotate detected languages; empty Final remains valid and needs application admission.
export class SpeechRecognition extends Context.Service<
  SpeechRecognition,
  {
    capabilities: RecognitionCapabilities
    recognize: (request: RecognitionRequest) => Stream.Stream<RecognitionEvent, RecognitionFailed>
  }
>()("balabol/speech-recognition") {}
const Script = Schema.Struct({
  events: Schema.Array(ScriptEvent).check(Schema.isMaxLength(MAX_SCRIPT_EVENTS)),
  delayMillis: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(MAX_DELAY_MILLIS)),
  failure: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_FAILURE_LENGTH)))
}).check(
  Schema.makeFilter((script) => {
    const finals = script.events.filter((event) => event.kind === "Final")
    return script.failure === null
      ? finals.length === 1 && script.events.at(LAST_INDEX)?.kind === "Final"
      : finals.length === 0
  })
)
const Configuration = Schema.Struct({
  languages: Languages,
  scripts: Schema.Array(Script).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_SCRIPTS))
})
export type FakeRecognitionConfiguration = typeof Configuration.Type
const defaultConfiguration: FakeRecognitionConfiguration = {
  languages: ["ru", "fr", "en"],
  scripts: [
    {
      events: [{ kind: "Final", text: "[Fake recognition] Bonjour", spans: [{ language: "fr", start: 19, end: 26 }] }],
      delayMillis: 80,
      failure: null
    }
  ]
}
const failed = (message: string) => new RecognitionFailed({ message })
const validateRequest = (raw: RecognitionRequest, languages: readonly RecognitionLanguage[]) =>
  Schema.decodeUnknownEffect(RecognitionRequest)(raw).pipe(
    Effect.mapError(() => failed("Invalid supplied recognition audio or request")),
    Effect.flatMap((request) =>
      request.allowedLanguages.every((language) => languages.includes(language))
        ? Effect.succeed(request)
        : Effect.fail(failed("Unsupported recognition language"))
    )
  )
const scriptedStream = (request: RecognitionRequest, script: typeof Script.Type) => {
  const events = Stream.fromIterable(script.events).pipe(
    Stream.mapEffect((event) =>
      Effect.sleep(script.delayMillis).pipe(
        Effect.andThen(
          Schema.decodeUnknownEffect(RecognitionEvent)({ ...event, utteranceId: request.utteranceId }).pipe(
            Effect.mapError(() => failed("Invalid recognition event")),
            Effect.flatMap((parsed) =>
              parsed.kind === "Final" && parsed.spans.some((span) => !request.allowedLanguages.includes(span.language))
                ? Effect.fail(failed("Detected language is outside the allowed set"))
                : Effect.succeed(parsed)
            )
          )
        )
      )
    )
  )
  return script.failure === null ? events : Stream.concat(events, Stream.fail(failed(script.failure)))
}
export const fakeRecognitionLayer = (configuration: FakeRecognitionConfiguration = defaultConfiguration) =>
  Layer.effect(
    SpeechRecognition,
    Schema.decodeUnknownEffect(Configuration)(configuration).pipe(
      Effect.mapError(() => failed("Invalid fake recognition configuration or terminal sequence")),
      Effect.map((config) => {
        let next = 0
        return SpeechRecognition.of({
          capabilities: {
            input: "supplied-audio",
            languages: config.languages,
            encoding: "pcm-s16le",
            sampleRateHz: SAMPLE_RATE_HZ,
            channels: 1,
            maximumSampleFrames: MAX_SAMPLE_FRAMES
          },
          recognize: (raw) =>
            Stream.unwrap(
              validateRequest(raw, config.languages).pipe(
                Effect.map((request) => {
                  const script = config.scripts[next % config.scripts.length]
                  next += 1
                  return script === undefined
                    ? Stream.fail(failed("Missing recognition fixture"))
                    : scriptedStream(request, script)
                })
              )
            )
        })
      })
    )
  )
