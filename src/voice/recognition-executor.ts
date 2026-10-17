import { randomUUID } from "node:crypto"
import { Cause, Deferred, Effect, Exit, Option, Schema, Stream } from "effect"
import type { Fiber, Scope } from "effect"
import { RecognitionEvent, RecognitionFailed } from "../speech-recognition/index.ts"
import type { SpeechRecognition } from "../speech-recognition/index.ts"
import { ActivityWindow } from "./activity.ts"
import { failed } from "./contracts.ts"
import type { RecognitionInput, RecognitionCommand, RecognitionError } from "./recognition-events.ts"
import type { RecognitionJob } from "./recognition-state.ts"
import { makeRecognitionFragments } from "./recognition-fragments.ts"
import type { RecognitionFragmentFailed } from "./recognition-fragments.ts"
type ResourceCommand = Extract<RecognitionCommand, { kind: "Recognize" | "Cancel" | "ReleaseFragment" }>
type SettledOutcome = Extract<RecognitionInput, { kind: "Settled" }>["outcome"]
interface Execution {
  readonly done: Deferred.Deferred<void>
  fiber?: Fiber.Fiber<void>
  cancelled: boolean
}
const recognitionError = (error: RecognitionFailed | RecognitionFragmentFailed): RecognitionError => ({
  code: "RecognitionFailed",
  message: error.message,
  reason: "reason" in error ? (error.reason ?? "Other") : "Other"
})
const defectOutcome = (): SettledOutcome => ({
  kind: "Defect",
  error: { code: "RecognitionFailed", message: "Unexpected recognition execution defect", reason: "Other" }
})
const settledOutcome = (exit: Exit.Exit<void, RecognitionFailed | RecognitionFragmentFailed>): SettledOutcome => {
  if (Exit.isSuccess(exit)) return { kind: "Success" }
  // A finalizer defect can coexist with an expected provider failure.
  if (exit.cause.reasons.some(Cause.isDieReason)) return defectOutcome()
  const error = Cause.findErrorOption(exit.cause)
  if (Option.isSome(error)) return { kind: "Failure", error: recognitionError(error.value) }
  if (exit.cause.reasons.every(Cause.isInterruptReason)) return { kind: "Interrupted" }
  return defectOutcome()
}
const ownPacket = (event: RecognitionEvent): RecognitionEvent =>
  event.kind === "Final" ? { ...event, spans: event.spans.map((span) => ({ ...span })) } : { ...event }
/** Interprets only reserved work and owned PCM. Slot and turn policy stays in the transition. */
export const makeRecognitionExecutor = (
  provider: SpeechRecognition["Service"],
  languages: readonly string[],
  captureScope: Scope.Scope,
  post: (input: RecognitionInput) => Effect.Effect<void>,
  authorized: (job: RecognitionJob) => boolean
) => {
  const fragments = makeRecognitionFragments()
  const executions = new Map<number, Execution>()
  const packet = (job: RecognitionJob, raw: unknown) =>
    Schema.decodeUnknownEffect(RecognitionEvent)(raw).pipe(
      Effect.matchEffect({
        onSuccess: (event) =>
          post({ kind: "Packet", operation: job.operation, generation: job.generation, event: ownPacket(event) }),
        onFailure: () =>
          post({
            kind: "Invalid",
            operation: job.operation,
            generation: job.generation,
            error: { code: "InvalidRecognition", message: "Invalid recognition event" }
          }).pipe(Effect.andThen(Effect.fail(new RecognitionFailed({ message: "Invalid recognition event" }))))
      })
    )
  const recognize = (job: RecognitionJob) =>
    Effect.gen(function* () {
      yield* post({ kind: "JobStarted", operation: job.operation, generation: job.generation })
      if (!authorized(job)) return
      const bytes = yield* fragments.materialize(job.slices)
      yield* provider
        .recognize({
          utteranceId: job.requestId,
          allowedLanguages: languages,
          audio: { encoding: "pcm-s16le", sampleRateHz: 16000, channels: 1, sampleFrames: job.sampleFrames, bytes }
        })
        .pipe(Stream.runForEach((raw) => packet(job, raw)))
    })
  const run = (job: RecognitionJob, execution: Execution) =>
    Effect.gen(function* () {
      const exit = yield* recognize(job).pipe(Effect.interruptible, Effect.exit)
      yield* post({
        kind: "Settled",
        operation: job.operation,
        generation: job.generation,
        outcome: settledOutcome(exit)
      })
      executions.delete(job.operation)
      yield* Deferred.succeed(execution.done, undefined)
    }).pipe(Effect.uninterruptible)
  const cancel = (execution: Execution | undefined) =>
    Effect.sync(() => {
      if (execution === undefined) return
      execution.cancelled = true
      execution.fiber?.interruptUnsafe()
    })
  const start = (job: RecognitionJob) =>
    Effect.gen(function* () {
      if (executions.has(job.operation)) return
      const execution: Execution = { done: Deferred.makeUnsafe<void>(), cancelled: false }
      executions.set(job.operation, execution)
      execution.fiber = yield* run(job, execution).pipe(
        Effect.forkIn(captureScope, { startImmediately: true, uninterruptible: true })
      )
      if (execution.cancelled) execution.fiber.interruptUnsafe()
    }).pipe(Effect.uninterruptible)
  return {
    execute: (command: ResourceCommand): Effect.Effect<void> => {
      switch (command.kind) {
        case "Recognize":
          return start(command.job)
        case "Cancel":
          return cancel(executions.get(command.operation))
        case "ReleaseFragment":
          return fragments.release(command.fragmentId)
      }
    },
    classified: (windows: readonly ActivityWindow[], generation: number) =>
      Effect.forEach(
        windows,
        (raw) =>
          Schema.decodeUnknownEffect(ActivityWindow)(raw).pipe(
            Effect.mapError(() => failed("InvalidAudio", "Invalid classified audio window")),
            Effect.flatMap((window) =>
              Effect.gen(function* () {
                const fragmentId = randomUUID()
                yield* fragments
                  .put(fragmentId, window.samples)
                  .pipe(Effect.mapError((error) => failed("InvalidAudio", error.message)))
                yield* post({
                  kind: "Window",
                  generation,
                  fragmentId,
                  sampleFrames: window.samples.length,
                  speech: window.speech,
                  turnId: randomUUID(),
                  fenceId: randomUUID(),
                  requestId: randomUUID()
                }).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? fragments.release(fragmentId) : Effect.void)))
              }).pipe(Effect.uninterruptible)
            )
          ),
        { discard: true }
      ),
    close: () =>
      Effect.gen(function* () {
        const pending = [...executions.values()]
        yield* Effect.forEach(pending, cancel, { discard: true })
        yield* Effect.forEach(pending, (execution) => Deferred.await(execution.done), { discard: true })
      })
  }
}
