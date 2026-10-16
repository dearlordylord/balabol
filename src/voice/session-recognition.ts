import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import type { Scope } from "effect"
import type { SpeechRecognition } from "../speech-recognition/index.ts"
import { RecognitionFailed } from "../speech-recognition/index.ts"
import { VoiceFailed } from "./contracts.ts"
import type { ActivityStream, ActivityWindow } from "./activity.ts"
import type { SessionEvent } from "./session-events.ts"
import type { ProvisionalFinal, SessionState } from "./session-state.ts"
import { Segmenter } from "./segmentation.ts"
import { Utterances } from "./utterances.ts"
import type { VoiceDiagnosticInput } from "./diagnostics.ts"
/** Bounded migration adapter: segmentation and recognition assembly move into the
 * Session transition in #56. It cannot write session lifecycle or admission state. */
export const makeSessionRecognition = (
  provider: SpeechRecognition["Service"],
  languages: readonly string[],
  scope: Scope.Scope,
  activity: ActivityStream,
  post: (event: SessionEvent) => Effect.Effect<SessionState, VoiceFailed>,
  current: () => SessionState,
  speech: (
    generation: number,
    fenceId: string
  ) => Effect.Effect<Pick<ProvisionalFinal, "generation" | "fenceId" | "sourceSequence">, VoiceFailed>,
  trace: (cause: VoiceDiagnosticInput["cause"], samples?: number) => void
) => {
  const segmenter = new Segmenter()
  let generation = 0
  let turnFence: Pick<ProvisionalFinal, "generation" | "fenceId" | "sourceSequence"> | undefined
  const event = (input: Parameters<typeof utterances.hooks.interim>[0], text: string) =>
    post({ kind: "Recognition", generation, event: { kind: "Interim", utteranceId: input, text } }).pipe(
      Effect.asVoid,
      Effect.ignore
    )
  const utterances = new Utterances(provider, languages, scope, {
    final: (id, text, languageSpans, detectedLanguage) => {
      const fence = turnFence
      if (fence === undefined) return Effect.void
      return post({ kind: "Final", ...fence, input: { id, text, languageSpans, detectedLanguage } }).pipe(
        Effect.asVoid,
        Effect.catch((error) =>
          post({
            kind: "Recognition",
            generation: fence.generation,
            event: { kind: "Error", utteranceId: id, code: error.code, message: error.message }
          }).pipe(Effect.asVoid, Effect.ignore)
        )
      )
    },
    interim: event,
    discarded: (utteranceId) =>
      post({ kind: "Recognition", generation, event: { kind: "Discarded", utteranceId, reason: "Empty" } }).pipe(
        Effect.asVoid,
        Effect.ignore
      ),
    error: (utteranceId, error) =>
      post({
        kind: "Recognition",
        generation,
        ...(error instanceof RecognitionFailed ? { recognitionReason: error.reason ?? "Other" } : {}),
        event: {
          kind: "Error",
          utteranceId,
          code: error instanceof VoiceFailed ? error.code : error._tag,
          message: error.message
        }
      }).pipe(Effect.asVoid, Effect.ignore),
    started: (samples) => trace("recognitionStarted", samples),
    succeeded: () => trace("recognitionSucceeded")
  })
  const active = (expected: number) =>
    current().generation === expected && current().phase === "active" && !current().muted
  const consumeChunk = (chunk: ReturnType<Segmenter["push"]>[number], expected: number) =>
    Effect.gen(function* () {
      if (!active(expected)) return
      if (chunk.speechStarted && utterances.start()) turnFence = yield* speech(expected, randomUUID())
      if (!active(expected)) return
      if (chunk.bytes !== undefined) yield* utterances.push(chunk.bytes, chunk.ended === true)
    })
  return {
    reset: () => {
      generation = current().generation
      turnFence = undefined
      segmenter.clear()
      activity.reset()
      utterances.reset()
    },
    close: () => utterances.close(),
    classified: (windows: readonly ActivityWindow[], expected: number) =>
      Effect.gen(function* () {
        if (!active(expected)) return
        generation = expected
        for (const window of windows) for (const chunk of segmenter.push(window)) yield* consumeChunk(chunk, expected)
      })
  }
}
