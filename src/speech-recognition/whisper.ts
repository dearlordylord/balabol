import { Effect, Layer, Schema, Semaphore, Stream } from "effect"
import { LanguageTag } from "../language/index.ts"
import { RecognitionEvent, RecognitionFailed, RecognitionRequest, SpeechRecognition } from "./provider.ts"
import { WhisperSettings, whisperNative } from "./whisper-native.ts"
import type { WhisperNative } from "./whisper-native.ts"
export { WhisperSettings, whisperModelBytes, whisperModelSha256, whisperNative } from "./whisper-native.ts"
export type { WhisperNative } from "./whisper-native.ts"
export { runWhisperProcess } from "./whisper-process.ts"
const deadlineMillis = 30000
const preparationMillis = 30000
const maximumTextLength = 100000
const maximumSegments = 10000
const maximumJsonBytes = 1024 * 1024
const supportedLanguages = ["ru", "fr", "en", "ja"]
const Segment = Schema.Struct({ text: Schema.String.check(Schema.isMaxLength(maximumTextLength)) })
// v1.9.5 examples/cli/cli.cpp output_json(): result.language plus ordered transcription[].text.
const WhisperResult = Schema.Struct({
  result: Schema.Struct({ language: Schema.NullOr(LanguageTag) }),
  transcription: Schema.Array(Segment).check(Schema.isMaxLength(maximumSegments))
})
const failed = (message: string) => new RecognitionFailed({ message })
const headerBytes = 44
const bytesPerSample = 2
const sampleRateHz = 16000
const formatChunkBytes = 16
const pcmFormat = 1
const bitsPerSample = 16
const riffOffset = 36
const offsets = {
  size: 4,
  format: 8,
  formatSize: 16,
  encoding: 20,
  channels: 22,
  rate: 24,
  byteRate: 28,
  block: 32,
  bits: 34,
  data: 36,
  dataSize: 40
}
const maximumSampleFrames = 240000
const encodeWav = (audio: RecognitionRequest["audio"]) => {
  const wav = Buffer.alloc(headerBytes + audio.bytes.byteLength)
  wav.write("RIFF", 0)
  wav.writeUInt32LE(riffOffset + audio.bytes.byteLength, offsets.size)
  wav.write("WAVEfmt ", offsets.format)
  wav.writeUInt32LE(formatChunkBytes, offsets.formatSize)
  wav.writeUInt16LE(pcmFormat, offsets.encoding)
  wav.writeUInt16LE(1, offsets.channels)
  wav.writeUInt32LE(sampleRateHz, offsets.rate)
  wav.writeUInt32LE(sampleRateHz * bytesPerSample, offsets.byteRate)
  wav.writeUInt16LE(bytesPerSample, offsets.block)
  wav.writeUInt16LE(bitsPerSample, offsets.bits)
  wav.write("data", offsets.data)
  wav.writeUInt32LE(audio.bytes.byteLength, offsets.dataSize)
  wav.set(audio.bytes, headerBytes)
  return wav
}
const parseFinal = (json: string, request: RecognitionRequest) =>
  Effect.gen(function* () {
    if (Buffer.byteLength(json, "utf8") > maximumJsonBytes) return yield* failed("Recognition JSON exceeded its limit")
    const raw = yield* Effect.try({
      try: (): unknown => JSON.parse(json),
      catch: () => failed("Invalid recognition JSON")
    })
    const result = yield* Schema.decodeUnknownEffect(WhisperResult)(raw).pipe(
      Effect.mapError(() => failed("Invalid recognition result"))
    )
    const text = result.transcription
      .map((segment) => segment.text)
      .join("")
      .trim()
    const detectedLanguage = text.length === 0 ? null : result.result.language
    if (detectedLanguage !== null && !request.allowedLanguages.includes(detectedLanguage))
      return yield* failed("Detected recognition language is outside the allowed set")
    return yield* Schema.decodeUnknownEffect(RecognitionEvent)({
      kind: "Final",
      utteranceId: request.utteranceId,
      text,
      detectedLanguage,
      spans: []
    }).pipe(Effect.mapError(() => failed("Invalid recognition final")))
  })
// One process per completed utterance; model load/warm-up belongs to the same bounded request.
// Cancellation closes the scope, reaps the process and deletes its private audio before releasing the permit.
export const whisperRecognitionLayer = (settings: WhisperSettings, native: WhisperNative = whisperNative) =>
  Layer.effect(
    SpeechRecognition,
    Effect.gen(function* () {
      const config = yield* Schema.decodeUnknownEffect(WhisperSettings)(settings).pipe(
        Effect.mapError(() => failed("Invalid local recognition configuration"))
      )
      yield* native.prepare(config).pipe(
        Effect.timeout(preparationMillis),
        Effect.mapError(() => failed("Local recognition preparation failed or timed out"))
      )
      const serial = yield* Semaphore.make(1)
      return SpeechRecognition.of({
        capabilities: {
          input: "supplied-audio",
          languages: supportedLanguages,
          encoding: "pcm-s16le",
          sampleRateHz,
          channels: 1,
          maximumSampleFrames
        },
        recognize: (raw) =>
          Stream.fromEffect(
            Effect.gen(function* () {
              const request = yield* Schema.decodeUnknownEffect(RecognitionRequest)(raw).pipe(
                Effect.mapError(() => failed("Invalid supplied recognition audio or request"))
              )
              if (!request.allowedLanguages.every((language) => supportedLanguages.includes(language)))
                return yield* failed("Unsupported recognition language")
              if (request.audio.sampleFrames === 0)
                return yield* parseFinal('{"result":{"language":null},"transcription":[]}', request)
              const json = yield* native.transcribe(config, encodeWav(request.audio))
              return yield* parseFinal(json, request)
            }).pipe(
              Effect.scoped,
              serial.withPermits(1),
              Effect.timeout(deadlineMillis),
              Effect.mapError(() => failed("Local recognition failed or exceeded its deadline"))
            )
          )
      })
    })
  )
