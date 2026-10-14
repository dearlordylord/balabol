import { Context, Effect, Layer, Schema, Stream } from "effect"

const SAMPLE_RATE = 24000
const MAX_PHRASE_CHARS = 800
const MAX_AUDIO_FRAMES = 240000
const MAX_CHUNK_FRAMES = 1200
const MAX_LANGUAGES = 4
const MAX_DELAY = 60000
const MAX_AMPLITUDE = 32767
const BYTES_PER_FRAME = 2
const TONE_HALF_PERIOD = 24
const MAX_CHUNKS = 200
const Language = Schema.Literals(["ru", "fr", "en", "ja"])
const Languages = Schema.Array(Language).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_LANGUAGES),
  Schema.isUnique()
)
const Identity = Schema.String.check(Schema.isUUID())
const Sequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(MAX_CHUNKS))
export const SynthesisRequest = Schema.Struct({
  responseId: Identity,
  phraseId: Identity,
  language: Language,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_PHRASE_CHARS))
})
export type SynthesisRequest = typeof SynthesisRequest.Type
export const SynthesisAudio = Schema.Struct({
  encoding: Schema.Literal("pcm-s16le"),
  sampleRateHz: Schema.Literal(SAMPLE_RATE),
  channels: Schema.Literal(1),
  sampleFrames: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(MAX_CHUNK_FRAMES)),
  bytes: Schema.Uint8Array
}).check(Schema.makeFilter((audio) => audio.bytes.byteLength === audio.sampleFrames * BYTES_PER_FRAME))
export type SynthesisAudio = typeof SynthesisAudio.Type
const eventIdentity = { responseId: Identity, phraseId: Identity, sequence: Sequence }
export const SynthesisEvent = Schema.Union([
  Schema.Struct({ ...eventIdentity, kind: Schema.Literal("Chunk"), audio: SynthesisAudio }),
  Schema.Struct({ ...eventIdentity, kind: Schema.Literal("Completed") })
])
export type SynthesisEvent = typeof SynthesisEvent.Type
export const SynthesisCapabilities = Schema.Struct({
  input: Schema.Literal("supplied-text"),
  output: Schema.Literal("streaming-pcm"),
  languages: Languages,
  encoding: Schema.Literal("pcm-s16le"),
  sampleRateHz: Schema.Literal(SAMPLE_RATE),
  channels: Schema.Literal(1),
  maxPhraseChars: Schema.Literal(MAX_PHRASE_CHARS),
  maxAudioFrames: Schema.Literal(MAX_AUDIO_FRAMES)
})
export type SynthesisCapabilities = typeof SynthesisCapabilities.Type
export class SpeechSynthesisFailed extends Schema.TaggedError<SpeechSynthesisFailed>()("SpeechSynthesisFailed", {
  message: Schema.String
}) {}
// Grounding: research/local-speech.md, MLX Qwen generate(text, stream=True).
// Complete phrase input yields audio chunks; this interface does not append text to an active request.
// Chunk sequence starts at zero; exactly one Completed uses the next sequence. Failure has no Completed.
export class SpeechSynthesis extends Context.Service<
  SpeechSynthesis,
  {
    capabilities: SynthesisCapabilities
    synthesize: (request: SynthesisRequest) => Stream.Stream<SynthesisEvent, SpeechSynthesisFailed>
  }
>()("balabol/speech-synthesis") {}
const Configuration = Schema.Struct({
  languages: Languages,
  sampleFrames: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(MAX_AUDIO_FRAMES)),
  amplitude: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(MAX_AMPLITUDE)),
  delayMillis: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(MAX_DELAY)),
  failureAfterChunks: Schema.NullOr(Sequence)
}).check(
  Schema.makeFilter(
    (config) =>
      config.failureAfterChunks === null ||
      config.failureAfterChunks <= Math.ceil(config.sampleFrames / MAX_CHUNK_FRAMES)
  )
)
export type FakeSynthesisConfiguration = Partial<typeof Configuration.Type>
const defaults: typeof Configuration.Type = {
  languages: ["ru", "fr", "en"],
  sampleFrames: 4800,
  amplitude: 1000,
  delayMillis: 20,
  failureAfterChunks: null
}
const failed = (message: string) => new SpeechSynthesisFailed({ message })
const tone = (frames: number, offset: number, amplitude: number): SynthesisAudio => {
  const bytes = new Uint8Array(frames * BYTES_PER_FRAME)
  const view = new DataView(bytes.buffer)
  for (let frame = 0; frame < frames; frame += 1) {
    const sample = Math.floor((offset + frame) / TONE_HALF_PERIOD) % BYTES_PER_FRAME === 0 ? amplitude : -amplitude
    view.setInt16(frame * BYTES_PER_FRAME, sample, true)
  }
  return { encoding: "pcm-s16le", sampleRateHz: SAMPLE_RATE, channels: 1, sampleFrames: frames, bytes }
}
const phraseStream = (request: SynthesisRequest, config: typeof Configuration.Type) => {
  const chunks = Math.ceil(config.sampleFrames / MAX_CHUNK_FRAMES)
  const events = Stream.range(0, chunks - 1).pipe(
    Stream.mapEffect((sequence) =>
      Effect.sleep(config.delayMillis).pipe(
        Effect.flatMap(() => {
          if (config.failureAfterChunks !== null && sequence >= config.failureAfterChunks)
            return Effect.fail(failed("Scripted synthesis failure"))
          const offset = sequence * MAX_CHUNK_FRAMES
          return Schema.decodeUnknownEffect(SynthesisEvent)({
            kind: "Chunk",
            responseId: request.responseId,
            phraseId: request.phraseId,
            sequence,
            audio: tone(Math.min(MAX_CHUNK_FRAMES, config.sampleFrames - offset), offset, config.amplitude)
          }).pipe(Effect.mapError(() => failed("Invalid synthesis audio event")))
        })
      )
    )
  )
  const terminal =
    config.failureAfterChunks === null
      ? Stream.succeed<SynthesisEvent>({
          kind: "Completed",
          responseId: request.responseId,
          phraseId: request.phraseId,
          sequence: chunks
        })
      : Stream.fail(failed("Scripted synthesis failure"))
  return Stream.concat(events, terminal)
}
export const fakeSynthesisLayer = (configuration: FakeSynthesisConfiguration = {}) =>
  Layer.effect(
    SpeechSynthesis,
    Schema.decodeUnknownEffect(Configuration)({ ...defaults, ...configuration }).pipe(
      Effect.mapError(() => failed("Invalid fake synthesis configuration")),
      Effect.map((config) =>
        SpeechSynthesis.of({
          capabilities: {
            input: "supplied-text",
            output: "streaming-pcm",
            languages: config.languages,
            encoding: "pcm-s16le",
            sampleRateHz: SAMPLE_RATE,
            channels: 1,
            maxPhraseChars: MAX_PHRASE_CHARS,
            maxAudioFrames: MAX_AUDIO_FRAMES
          },
          synthesize: (raw) =>
            Stream.unwrap(
              Schema.decodeUnknownEffect(SynthesisRequest)(raw).pipe(
                Effect.mapError(() => failed("Invalid synthesis phrase request")),
                Effect.flatMap((request) =>
                  config.languages.includes(request.language)
                    ? Effect.succeed(phraseStream(request, config))
                    : Effect.fail(failed("Unsupported synthesis language"))
                )
              )
            )
        })
      )
    )
  )
