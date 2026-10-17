import { randomUUID } from "node:crypto"
import { Deferred, Effect, Schema, Stream } from "effect"
import { SynthesisEvent } from "../speech-synthesis/index.ts"
import { outputAuthorized } from "./output-transition.ts"
import { outputError } from "./output-executor-resources.ts"
import type { OutputResources } from "./output-executor-resources.ts"
import type { OutputCommand } from "./output-events.ts"
type Synthesize = Extract<OutputCommand, { kind: "Synthesize" }>
type Capture = Extract<OutputCommand, { kind: "Capture" }>
const packet = (resources: OutputResources, command: Synthesize, raw: unknown) =>
  Schema.decodeUnknownEffect(SynthesisEvent)(raw).pipe(
    Effect.mapError(() => ({ code: "AudioUnavailable", message: "Invalid synthesis event" })),
    Effect.flatMap((event) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const base = {
            operation: command.operation,
            key: command.key,
            responseId: event.responseId,
            phraseId: event.phraseId,
            sequence: event.sequence
          }
          if (event.kind === "Completed") {
            yield* resources.post({ kind: "SynthesisPacket", ...base, packet: { kind: "Completed" } })
            return
          }
          const payloadId = randomUUID()
          const payload = {
            audio: { ...event.audio, bytes: event.audio.bytes.slice() },
            released: Deferred.makeUnsafe<void>()
          }
          resources.payloads.set(payloadId, payload)
          yield* resources.deps
            .post({
              kind: "SynthesisPacket",
              ...base,
              packet: { kind: "Chunk", payloadId, sampleFrames: event.audio.sampleFrames }
            })
            .pipe(
              Effect.mapError(outputError),
              Effect.onExit((exit) => (exit._tag === "Failure" ? resources.releasePayload(payloadId) : Effect.void))
            )
          yield* restore(Deferred.await(payload.released))
        })
      )
    )
  )
export const executeSynthesis = (resources: OutputResources, command: Synthesize) =>
  resources.start(
    "Synthesis",
    command.operation,
    Effect.gen(function* () {
      const exit = yield* Effect.suspend(() =>
        resources.deps.synthesis
          .synthesize({
            responseId: command.key.ticket.responseId,
            phraseId: command.phraseId,
            language: command.phrase.language,
            text: command.phrase.text
          })
          .pipe(Stream.runForEach((raw) => packet(resources, command, raw)))
      ).pipe(Effect.mapError(outputError), Effect.interruptible, Effect.exit)
      yield* resources.post({
        kind: "SynthesisSettled",
        operation: command.operation,
        key: command.key,
        outcome: resources.outcome(exit),
        nextPhraseId: randomUUID()
      })
    }).pipe(Effect.uninterruptible)
  )
export const executeCapture = (resources: OutputResources, command: Capture) =>
  resources.start(
    "Capture",
    command.operation,
    Effect.gen(function* () {
      const exit = yield* Effect.suspend(() => {
        const publication = resources.publications.get(command.publicationOperation)?.handle
        const payload = resources.payloads.get(command.payloadId)
        if (publication === undefined || payload === undefined)
          return Effect.fail({ code: "AudioUnavailable", message: "Reply audio resource is unavailable" })
        if (
          !outputAuthorized(resources.deps.current(), command.key, command.publicationOperation) ||
          !resources.deps.conversation.replyDeliveryAuthorization(command.key.ticket).isAuthorized()
        )
          return Effect.interrupt
        return publication.capture(payload.audio).pipe(Effect.mapError(outputError))
      }).pipe(Effect.interruptible, Effect.exit)
      yield* resources.post({
        kind: "CaptureFinished",
        operation: command.operation,
        key: command.key,
        outcome: resources.outcome(exit)
      })
    }).pipe(Effect.uninterruptible)
  )
