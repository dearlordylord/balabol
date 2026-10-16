import { randomUUID } from "node:crypto"
import { Effect, Fiber, Schema, Stream } from "effect"
import type { Scope } from "effect"
import { RecognitionEvent, RecognitionFailed } from "../speech-recognition/index.ts"
import type { SpeechRecognition } from "../speech-recognition/index.ts"
import { failed, type VoiceFailed } from "./contracts.ts"
import type { LanguageSpan } from "../language/index.ts"

const maximumConcurrent = 2
const maximumChunks = 30
const maximumText = 100000
const maximumSpans = 1000
const bytesPerSample = 2
type Final = Extract<RecognitionEvent, { kind: "Final" }>
type Turn = {
  id: string
  ended: boolean
  chunks: number
  results: Map<number, Final>
  textLength: number
  spanCount: number
}
type Chunk = { turn: Turn; index: number; bytes: Uint8Array }
type Hooks = {
  final: (id: string, text: string, spans: readonly LanguageSpan[], language: string | null) => Effect.Effect<void>
  interim: (id: string, text: string) => Effect.Effect<void>
  discarded: (id: string) => Effect.Effect<void>
  error: (id: string, error: RecognitionFailed | VoiceFailed) => Effect.Effect<void>
  started: (samples: number) => void
  succeeded: () => void
}

/** Recognition chunks are bounded transport, never conversational turns. One provisional
 * turn survives rollover and speech resumption until quiet AND every chunk is final.
 * Queueing is bounded to 30 chunks (up to five minutes; pauses can consume chunks sooner);
 * two provider requests run concurrently.
 * Failure drops the entire provisional turn and suppresses its suffix until quiet. */
export class Utterances {
  #turn: Turn | undefined
  #suppressed = false
  #queue: Chunk[] = []
  #running = new Map<Fiber.Fiber<void>, Chunk>()
  constructor(
    readonly provider: SpeechRecognition["Service"],
    readonly languages: readonly string[],
    readonly scope: Scope.Scope,
    readonly hooks: Hooks
  ) {}
  start() {
    if (this.#suppressed) return false
    if (this.#turn !== undefined) {
      this.#turn.ended = false
      return false
    }
    this.#turn = { id: randomUUID(), ended: false, chunks: 0, results: new Map(), textLength: 0, spanCount: 0 }
    return true
  }
  reset() {
    this.#turn = undefined
    this.#suppressed = false
    this.#queue = []
    for (const fiber of this.#running.keys()) fiber.interruptUnsafe()
  }
  close() {
    this.reset()
    return Effect.forEach(this.#running.keys(), (fiber) => Fiber.interrupt(fiber), { discard: true })
  }
  push(bytes: Uint8Array, ended: boolean) {
    return Effect.gen({ self: this }, function* () {
      if (this.#suppressed) {
        if (ended) this.#suppressed = false
        return
      }
      const turn = this.#turn
      if (turn === undefined) return
      turn.ended = ended
      if (turn.chunks >= maximumChunks)
        return yield* this.#fail(
          turn,
          new RecognitionFailed({ message: "Spoken turn exceeds recognition chunk capacity" })
        )
      this.#queue.push({ turn, index: turn.chunks++, bytes })
      yield* this.#pump()
    })
  }
  #fail(turn: Turn, error: RecognitionFailed | VoiceFailed, current?: Chunk) {
    if (this.#turn !== turn) return Effect.void
    this.#turn = undefined
    this.#suppressed = !turn.ended
    this.#queue = []
    // Fence before cancellation; callbacks already scheduled must also remain inert.
    return Effect.forEach(
      [...this.#running].filter(([, chunk]) => chunk !== current),
      ([fiber]) => Fiber.interrupt(fiber).pipe(Effect.forkIn(this.scope)),
      { discard: true }
    ).pipe(Effect.andThen(this.hooks.error(turn.id, error)))
  }
  #pump(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      while (this.#running.size < maximumConcurrent && this.#queue.length > 0) {
        const chunk = this.#queue.shift()
        if (chunk === undefined) return
        const fiber = yield* this.#recognize(chunk).pipe(Effect.forkIn(this.scope))
        this.#running.set(fiber, chunk)
        yield* Fiber.await(fiber).pipe(
          Effect.andThen(Effect.sync(() => this.#running.delete(fiber))),
          Effect.andThen(this.#pump()),
          Effect.forkIn(this.scope)
        )
      }
    })
  }
  #validate(event: RecognitionEvent): Effect.Effect<RecognitionEvent, RecognitionFailed | VoiceFailed> {
    if (event.kind === "Interim") return Effect.succeed(event)
    const supported =
      event.spans.every((span) => this.languages.includes(span.language)) &&
      (event.detectedLanguage == null || this.languages.includes(event.detectedLanguage))
    return supported
      ? Effect.succeed(event)
      : Effect.fail(failed("InvalidRecognition", "Detected language is outside the configured set"))
  }
  #recognize(chunk: Chunk) {
    const id = randomUUID()
    let final: Final | undefined
    this.hooks.started(chunk.bytes.length / bytesPerSample)
    return this.provider
      .recognize({
        utteranceId: id,
        allowedLanguages: this.languages,
        audio: {
          encoding: "pcm-s16le",
          sampleRateHz: 16000,
          channels: 1,
          sampleFrames: chunk.bytes.length / bytesPerSample,
          bytes: chunk.bytes
        }
      })
      .pipe(
        Stream.runForEach((raw) =>
          Schema.decodeUnknownEffect(RecognitionEvent)(raw).pipe(
            Effect.mapError(() => failed("InvalidRecognition", "Invalid recognition event")),

            Effect.flatMap((event) => {
              if (this.#turn !== chunk.turn || event.utteranceId !== id || final !== undefined) return Effect.void
              if (event.kind === "Interim") return this.hooks.interim(chunk.turn.id, event.text)
              return this.#validate(event).pipe(
                Effect.map(() => {
                  final = event
                })
              )
            })
          )
        ),
        Effect.flatMap(() =>
          final === undefined
            ? Effect.fail(new RecognitionFailed({ reason: "Final", message: "Recognition stream ended without final" }))
            : this.#complete(chunk, final)
        ),
        Effect.catch((error) => this.#fail(chunk.turn, error, chunk)),
        Effect.asVoid
      )
  }
  #complete(chunk: Chunk, final: Final) {
    return Effect.gen({ self: this }, function* () {
      const turn = chunk.turn
      if (this.#turn !== turn) return
      turn.textLength += final.text.length + 1
      turn.spanCount += final.spans.length
      if (turn.textLength > maximumText || turn.spanCount > maximumSpans)
        return yield* this.#fail(
          turn,
          new RecognitionFailed({ message: "Spoken turn exceeds transcript capacity" }),
          chunk
        )
      turn.results.set(chunk.index, final)
      this.hooks.succeeded()
      if (!turn.ended || turn.results.size !== turn.chunks) return
      const result = assemble(turn)
      this.#turn = undefined
      yield* result.text.trim().length === 0
        ? this.hooks.discarded(turn.id)
        : this.hooks.final(turn.id, result.text, result.spans, result.language)
    })
  }
}
const assemble = (turn: Turn) => {
  let text = ""
  const spans: LanguageSpan[] = []
  const languages = new Set<string | null>()
  const ordered = [...turn.results].sort(([left], [right]) => left - right).map(([, result]) => result)
  for (const result of ordered) {
    if (result.text.trim().length === 0) continue
    if (text.length > 0) text += " "
    const offset = text.length
    text += result.text
    for (const span of result.spans) spans.push({ ...span, start: span.start + offset, end: span.end + offset })
    languages.add(result.detectedLanguage ?? null)
    for (const span of result.spans) languages.add(span.language)
  }
  return { text, spans, language: detectedLanguage(languages) }
}

const detectedLanguage = (languages: Set<string | null>) => (languages.size === 1 ? ([...languages][0] ?? null) : null)
