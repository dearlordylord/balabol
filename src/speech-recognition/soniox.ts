import { Cause, Deferred, Effect, Layer, Queue, Redacted, Schema, Stream } from "effect"
import {
  RecognitionAudio,
  RecognitionEvent,
  RecognitionFailed,
  RecognitionRequest,
  StreamingRecognitionRequest,
  SpeechRecognition
} from "./provider.ts"
import { emptySonioxTranscript, reduceSonioxPacket, sonioxFailure } from "./soniox-protocol.ts"
export const SonioxSettings = Schema.Struct({
  provider: Schema.Literal("soniox"),
  apiKey: Schema.Redacted(Schema.NonEmptyString)
})
export type SonioxSettings = typeof SonioxSettings.Type
/** The socket factory is the network port; tests supply sockets, never patch globals. */
export type SonioxSocketFactory = (url: string, protocols: readonly string[]) => WebSocket
const connect: SonioxSocketFactory = (url, protocols) => new WebSocket(url, [...protocols])
const maximumBufferedBytes = 524288
const maximumSampleFrames = 240000
const requestDeadlineMillis = 30000
const endpoint = "wss://stt-rt.soniox.com/transcribe-websocket"
// Grounding: https://soniox.com/docs/api-reference/stt/websocket-api
// Voice owns endpointing; each bounded chunk streams before its final close.
const transcriptEvent = (utteranceId: string, selected: typeof emptySonioxTranscript, finished: boolean) => {
  const languages = [...new Set(selected.spans.map((span) => span.language))]
  return Schema.decodeUnknownSync(RecognitionEvent)(
    finished
      ? {
          kind: "Final",
          utteranceId,
          text: selected.text,
          spans: selected.spans,
          detectedLanguage: languages.length === 1 ? languages[0] : null
        }
      : { kind: "Interim", utteranceId, text: selected.text }
  )
}
const emptyHypothesis = (finished: boolean, text: string) => !finished && text.length === 0
const transcribe = (
  request: StreamingRecognitionRequest,
  audio: Stream.Stream<RecognitionAudio, RecognitionFailed>,
  settings: SonioxSettings,
  factory: SonioxSocketFactory
) =>
  Stream.callback<RecognitionEvent, RecognitionFailed>(
    (queue) =>
      Effect.gen(function* () {
        let terminal = false
        const socket = yield* Effect.acquireRelease(
          Effect.try({
            try: () => factory(endpoint, ["soniox-api-key", Redacted.value(settings.apiKey)]),
            catch: () => sonioxFailure("Soniox connection could not be created", "Transport")
          }),
          (connection) =>
            Effect.sync(() => {
              terminal = true
              connection.onopen = null
              connection.onmessage = null
              connection.onerror = null
              connection.onclose = null
              connection.close()
            })
        )
        const opened = yield* Deferred.make<void>()
        let inputEnded = false
        let inputSamples = 0
        let transcript = emptySonioxTranscript
        let finished = false
        const fail = (error: RecognitionFailed) => {
          if (terminal) return
          terminal = true
          Queue.failCauseUnsafe(queue, Cause.fail(error))
        }
        yield* Effect.sleep(requestDeadlineMillis).pipe(
          Effect.andThen(Effect.sync(() => fail(sonioxFailure("Soniox recognition deadline exceeded", "Deadline")))),
          Effect.forkScoped
        )
        socket.onopen = () => {
          if (terminal) return
          try {
            socket.send(
              JSON.stringify({
                model: "stt-rt-v5",
                audio_format: "pcm_s16le",
                sample_rate: 16000,
                num_channels: 1,
                language_hints: request.allowedLanguages,
                language_hints_strict: true,
                enable_language_identification: true,
                enable_endpoint_detection: false
              })
            )
            Deferred.doneUnsafe(opened, Effect.void)
          } catch {
            fail(sonioxFailure("Soniox audio submission failed", "Transport"))
          }
        }
        yield* Deferred.await(opened).pipe(
          Effect.andThen(
            Stream.runForEach(audio, (raw) =>
              Schema.decodeUnknownEffect(RecognitionAudio)(raw).pipe(
                Effect.mapError(() => sonioxFailure("Invalid Soniox audio frame", "InvalidRequest")),
                Effect.flatMap((frame) =>
                  Effect.try({
                    try: () => {
                      if (terminal) throw sonioxFailure("Soniox input is no longer active", "Incomplete")
                      inputSamples += frame.sampleFrames
                      if (inputSamples > maximumSampleFrames)
                        throw sonioxFailure("Soniox audio input capacity exceeded", "Limit")
                      if (socket.bufferedAmount + frame.bytes.byteLength > maximumBufferedBytes)
                        throw sonioxFailure("Soniox audio send capacity exceeded", "Limit")
                      socket.send(frame.bytes)
                    },
                    catch: (error) =>
                      error instanceof RecognitionFailed
                        ? error
                        : sonioxFailure("Soniox audio submission failed", "Transport")
                  })
                )
              )
            )
          ),
          Effect.andThen(
            Effect.try({
              try: () => {
                if (terminal) throw sonioxFailure("Soniox input closed prematurely", "Incomplete")
                inputEnded = true
                socket.send("")
              },
              catch: (error) =>
                error instanceof RecognitionFailed ? error : sonioxFailure("Soniox finalization failed", "Transport")
            })
          ),
          Effect.catch((error) => Effect.sync(() => fail(error))),
          Effect.forkScoped
        )
        const publish = (event: RecognitionEvent) => {
          if (!Queue.offerUnsafe(queue, event)) fail(sonioxFailure("Soniox event capacity exceeded", "Limit"))
          if (finished) {
            terminal = true
            Queue.endUnsafe(queue)
          }
        }
        socket.onmessage = (message) => {
          if (terminal) return
          try {
            const result = reduceSonioxPacket(transcript, message.data, request.allowedLanguages)
            transcript = result.committed
            if (result.finished && !inputEnded) throw sonioxFailure("Soniox finished before audio ended", "Incomplete")
            finished = result.finished
            const selected = finished ? transcript : result.provisional
            // A provider heartbeat is not a valid client Interim text event.
            if (emptyHypothesis(finished, selected.text)) return
            const event = transcriptEvent(request.utteranceId, selected, finished)
            publish(event)
          } catch (error) {
            fail(error instanceof RecognitionFailed ? error : sonioxFailure("Invalid Soniox response"))
          }
        }
        socket.onerror = () => fail(sonioxFailure("Soniox network connection failed", "Transport"))
        socket.onclose = () => {
          if (!finished) fail(sonioxFailure("Soniox closed before recognition finished", "Incomplete"))
        }
      }),
    { bufferSize: 64 }
  )
export const sonioxRecognitionLayer = (settings: SonioxSettings, factory: SonioxSocketFactory = connect) =>
  Layer.effect(
    SpeechRecognition,
    Effect.gen(function* () {
      const config = yield* Schema.decodeUnknownEffect(SonioxSettings)(settings).pipe(
        Effect.mapError(() => sonioxFailure("Soniox requires a nonempty SONIOX_API_KEY", "Authentication"))
      )
      return SpeechRecognition.of({
        capabilities: {
          input: "supplied-audio",
          languages: ["ru", "fr", "en", "ja"],
          encoding: "pcm-s16le",
          sampleRateHz: 16000,
          channels: 1,
          maximumSampleFrames: 240000
        },
        recognize: (raw) =>
          Stream.unwrap(
            Schema.decodeUnknownEffect(RecognitionRequest)(raw).pipe(
              Effect.mapError(() => sonioxFailure("Invalid Soniox recognition request", "InvalidRequest")),
              Effect.map((request) => transcribe(request, Stream.make(request.audio), config, factory))
            )
          ),
        recognizeStreaming: (raw, audio) =>
          Stream.unwrap(
            Schema.decodeUnknownEffect(StreamingRecognitionRequest)(raw).pipe(
              Effect.mapError(() => sonioxFailure("Invalid Soniox recognition request", "InvalidRequest")),
              Effect.map((request) => transcribe(request, audio, config, factory))
            )
          )
      })
    })
  )
