import { withAuditSpan } from "../operation-audit/index.ts"
import { Cause, Deferred, Effect, Exit, Option } from "effect"
import type { Fiber, Scope } from "effect"
import type { Conversation, ReplyDeliverySubscription } from "../conversation/index.ts"
import type { SpeechSynthesis, SynthesisAudio } from "../speech-synthesis/index.ts"
import type { DeliveryFailure } from "../delivery-failure/index.ts"
import type { AudioPublication, MediaConnection, VoiceFailed } from "./contracts.ts"
import type { OutputEvent, OutputOutcome } from "./output-events.ts"
import type { OutputDecision, OutputState, OutputError, OutputKey } from "./output-state.ts"
import { recordVoiceDiagnostic } from "./diagnostics.ts"
import type { VoiceDiagnostics } from "./diagnostics.ts"
export interface OutputExecutorDependencies {
  readonly conversation: Conversation["Service"]
  readonly synthesis: SpeechSynthesis["Service"]
  readonly connection: () => MediaConnection | undefined
  readonly scope: Scope.Scope
  readonly post: (event: OutputEvent) => Effect.Effect<OutputDecision, VoiceFailed>
  readonly current: () => OutputState
  readonly diagnostics: VoiceDiagnostics["Service"]
  readonly sessionId: string
}
interface WorkEntry {
  readonly operation: number
  readonly done: Deferred.Deferred<void>
  fiber?: Fiber.Fiber<void>
  cancelled: boolean
}
export interface PublicationEntry {
  readonly key: OutputKey
  revoked: boolean
  handle?: AudioPublication
}
export interface OutputPayload {
  readonly audio: SynthesisAudio
  readonly released: Deferred.Deferred<void>
}
export interface OutputSubscription {
  readonly subscription: ReplyDeliverySubscription
  readonly started: Deferred.Deferred<void>
  fiber?: Fiber.Fiber<void>
}
export const outputError = (error: {
  readonly message: string
  readonly reason?: NonNullable<DeliveryFailure["reason"]>
}): OutputError => ({
  code: "AudioUnavailable",
  message: error.message,
  ...(error.reason === undefined ? {} : { reason: error.reason })
})
export const makeOutputResources = (deps: OutputExecutorDependencies) => {
  const work = new Map<string, WorkEntry>()
  const publications = new Map<number, PublicationEntry>()
  const payloads = new Map<string, OutputPayload>()
  const subscriptions = new Map<string, OutputSubscription>()
  const attached = Deferred.makeUnsafe<void, VoiceFailed>()
  let changed = Deferred.makeUnsafe<void>()
  const notify = () =>
    Effect.suspend(() => {
      const previous = changed
      changed = Deferred.makeUnsafe<void>()
      return Deferred.succeed(previous, undefined).pipe(Effect.asVoid)
    })
  const post = (event: OutputEvent) =>
    deps
      .post(event)
      .pipe(
        withAuditSpan("voice.eventDelivery", "key" in event ? event.key.ticket.responseId : undefined),
        Effect.asVoid,
        Effect.ignore
      )
  const outcome = (exit: Exit.Exit<unknown, OutputError>): OutputOutcome => {
    if (Exit.isSuccess(exit)) return { kind: "Success" }
    if (exit.cause.reasons.some(Cause.isDieReason)) {
      recordVoiceDiagnostic(deps.diagnostics, {
        cause: "outputDefect",
        sessionId: deps.sessionId,
        applied: true,
        errorCode: "AudioUnavailable"
      })
      return { kind: "Failure", error: { code: "AudioUnavailable", message: "Unexpected audio output failure" } }
    }
    const error = Cause.findErrorOption(exit.cause)
    return Option.isSome(error) ? { kind: "Failure", error: error.value } : { kind: "Interrupted" }
  }
  const start = (label: string, operation: number, task: Effect.Effect<void>) =>
    Effect.gen(function* () {
      const id = `${label}:${operation}`
      if (work.has(id)) return
      const entry: WorkEntry = { operation, done: Deferred.makeUnsafe<void>(), cancelled: false }
      work.set(id, entry)
      entry.fiber = yield* task.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            work.delete(id)
          }).pipe(Effect.andThen(Deferred.succeed(entry.done, undefined)), Effect.andThen(notify()))
        ),
        Effect.forkIn(deps.scope, { startImmediately: true, uninterruptible: true })
      )
      if (entry.cancelled) entry.fiber.interruptUnsafe()
    }).pipe(Effect.uninterruptible)
  const spanNames = {
    Drain: "voice.drain",
    Settlement: "voice.settlement",
    Unregister: "voice.unregister",
    ReadReply: "voice.reply",
    ReadyTimer: "voice.readyWait"
  }
  const run = (
    label: keyof typeof spanNames,
    operation: number,
    task: Effect.Effect<OutputEvent, OutputError>,
    failure: (error: OutputError) => OutputEvent,
    responseId?: string
  ) =>
    start(
      label,
      operation,
      Effect.gen(function* () {
        const exit = yield* task.pipe(withAuditSpan(spanNames[label], responseId), Effect.interruptible, Effect.exit)
        const result = outcome(exit)
        if (Exit.isSuccess(exit)) return yield* post(exit.value)
        // Cancel dispatch is synchronous in the owner before later completion facts are processed.
        if (result.kind === "Interrupted" && work.get(`${label}:${operation}`)?.cancelled === true)
          return yield* post({ kind: "Released", operation })
        const error =
          result.kind === "Failure"
            ? result.error
            : { code: "AudioUnavailable", message: "Audio output work was interrupted" }
        yield* post(failure(error))
      }).pipe(Effect.uninterruptible)
    )
  const cancel = (operation: number) =>
    Effect.sync(() => {
      for (const entry of work.values())
        if (entry.operation === operation) {
          entry.cancelled = true
          entry.fiber?.interruptUnsafe()
        }
    })
  const releasePayload = (id: string) =>
    Effect.suspend(() => {
      const payload = payloads.get(id)
      payloads.delete(id)
      return payload === undefined
        ? Effect.void
        : Deferred.succeed(payload.released, undefined).pipe(Effect.asVoid, Effect.andThen(notify()))
    })
  const close = () =>
    Effect.gen(function* () {
      while (work.size > 0 || publications.size > 0 || subscriptions.size > 0 || payloads.size > 0) {
        const pending = changed
        yield* Deferred.await(pending)
      }
    })
  return {
    deps,
    publications,
    payloads,
    subscriptions,
    attached,
    post,
    outcome,
    start,
    run,
    cancel,
    releasePayload,
    close,
    notify
  }
}
export type OutputResources = ReturnType<typeof makeOutputResources>
