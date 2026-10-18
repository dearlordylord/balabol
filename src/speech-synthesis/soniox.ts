import { Cause, Effect, Layer, Queue, Redacted, Schema, Stream } from "effect"
import { SpeechSynthesis, SpeechSynthesisFailed, SynthesisRequest, type SynthesisEvent } from "./provider.ts"
import { emptySonioxAudio, reduceSonioxAudio, sonioxSynthesisFailure } from "./soniox-protocol.ts"
export const SonioxSynthesisSettings = Schema.Struct({
  provider: Schema.Literal("soniox"),
  apiKey: Schema.Redacted(Schema.NonEmptyString),
  voice: Schema.NonEmptyString
})
export type SonioxSynthesisSettings = typeof SonioxSynthesisSettings.Type
export type SonioxSynthesisSocketFactory = (url: string, protocols: readonly string[]) => WebSocket
const connect: SonioxSynthesisSocketFactory = (url, protocols) => new WebSocket(url, [...protocols])
const endpoint = "wss://tts-rt.soniox.com/tts-websocket"
const chunkBytes = 2400
const frameBytes = 2
const deadlineMillis = 60000
const synthesize = (
  request: SynthesisRequest,
  settings: SonioxSynthesisSettings,
  factory: SonioxSynthesisSocketFactory
) =>
  Stream.callback<SynthesisEvent, SpeechSynthesisFailed>(
    (queue) =>
      Effect.gen(function* () {
        let terminal = false
        let opened = false
        let state = emptySonioxAudio
        let sequence = 0
        let remainder = Buffer.alloc(0)
        const socket = yield* Effect.acquireRelease(
          Effect.try({
            try: () => factory(endpoint, ["soniox-api-key", Redacted.value(settings.apiKey)]),
            catch: () => sonioxSynthesisFailure("Soniox synthesis connection could not be created", "Transport")
          }),
          (connection) =>
            Effect.sync(() => {
              terminal = true
              connection.onopen = null
              connection.onmessage = null
              connection.onerror = null
              connection.onclose = null
              if (opened && !state.terminated) {
                try {
                  connection.send(JSON.stringify({ stream_id: request.phraseId, cancel: true }))
                } catch {
                  /* Closing still releases a failed socket. */
                }
              }
              connection.close()
            })
        )
        const fail = (error: SpeechSynthesisFailed) => {
          if (!terminal) {
            terminal = true
            Queue.failCauseUnsafe(queue, Cause.fail(error))
          }
        }
        yield* Effect.sleep(deadlineMillis).pipe(
          Effect.andThen(
            Effect.sync(() => fail(sonioxSynthesisFailure("Soniox synthesis deadline exceeded", "Deadline")))
          ),
          Effect.forkScoped
        )
        socket.onopen = () => {
          if (terminal) return
          opened = true
          try {
            socket.send(
              JSON.stringify({
                stream_id: request.phraseId,
                model: "tts-rt-v2",
                language: request.language,
                voice: settings.voice,
                audio_format: "pcm_s16le",
                sample_rate: 24000
              })
            )
            socket.send(JSON.stringify({ stream_id: request.phraseId, text: request.text, text_end: true }))
          } catch {
            fail(sonioxSynthesisFailure("Soniox synthesis text submission failed", "Transport"))
          }
        }
        const publish = (event: SynthesisEvent) => {
          if (!Queue.offerUnsafe(queue, event))
            throw sonioxSynthesisFailure("Soniox synthesis event capacity exceeded", "Limit")
        }
        socket.onmessage = (message) => {
          if (terminal) return
          try {
            const result = reduceSonioxAudio(state, message.data, request.phraseId)
            state = result.state
            const buffered = Buffer.concat([remainder, result.audio])
            const emittedBytes = state.audioEnded ? buffered.length : buffered.length - (buffered.length % chunkBytes)
            remainder = buffered.subarray(emittedBytes)
            for (let offset = 0; offset < emittedBytes; offset += chunkBytes) {
              const bytes = buffered.subarray(offset, Math.min(offset + chunkBytes, emittedBytes))
              publish({
                kind: "Chunk",
                responseId: request.responseId,
                phraseId: request.phraseId,
                sequence: sequence++,
                audio: {
                  encoding: "pcm-s16le",
                  sampleRateHz: 24000,
                  channels: 1,
                  sampleFrames: bytes.length / frameBytes,
                  bytes
                }
              })
            }
            if (state.terminated) {
              publish({ kind: "Completed", responseId: request.responseId, phraseId: request.phraseId, sequence })
              terminal = true
              Queue.endUnsafe(queue)
            }
          } catch (error) {
            fail(
              error instanceof SpeechSynthesisFailed
                ? error
                : sonioxSynthesisFailure("Invalid Soniox synthesis response")
            )
          }
        }
        socket.onerror = () => fail(sonioxSynthesisFailure("Soniox synthesis network connection failed", "Transport"))
        socket.onclose = () => fail(sonioxSynthesisFailure("Soniox closed before synthesis finished", "Incomplete"))
      }),
    { bufferSize: 1201 }
  )
export const sonioxSynthesisLayer = (
  settings: SonioxSynthesisSettings,
  factory: SonioxSynthesisSocketFactory = connect
) =>
  Layer.effect(
    SpeechSynthesis,
    Effect.gen(function* () {
      const config = yield* Schema.decodeUnknownEffect(SonioxSynthesisSettings)(settings).pipe(
        Effect.mapError(() =>
          sonioxSynthesisFailure("Soniox requires an API key and synthesis voice", "InvalidRequest")
        )
      )
      return SpeechSynthesis.of({
        capabilities: {
          input: "supplied-text",
          output: "streaming-pcm",
          languages: ["ru", "fr", "en", "ja"],
          encoding: "pcm-s16le",
          sampleRateHz: 24000,
          channels: 1,
          maxPhraseChars: 800,
          maxAudioFrames: 1440000
        },
        synthesize: (raw) =>
          Stream.unwrap(
            Schema.decodeUnknownEffect(SynthesisRequest)(raw).pipe(
              Effect.mapError(() => sonioxSynthesisFailure("Invalid Soniox synthesis request", "InvalidRequest")),
              Effect.flatMap((request) =>
                ["ru", "fr", "en", "ja"].includes(request.language)
                  ? Effect.succeed(synthesize(request, config, factory))
                  : Effect.fail(sonioxSynthesisFailure("Unsupported Soniox synthesis language", "UnsupportedLanguage"))
              )
            )
          )
      })
    })
  )
