import { withAuditSpan } from "../operation-audit/index.ts"
import { randomUUID } from "node:crypto"
import { Clock, Deferred, Effect, Fiber, Schema, Stream } from "effect"
import { SynthesisCapabilities } from "../speech-synthesis/index.ts"
import { failed } from "./contracts.ts"
import { outputAuthorized } from "./output-transition.ts"
import { recordVoiceDiagnostic } from "./diagnostics.ts"
import { outputError } from "./output-executor-resources.ts"
import type { OutputResources, PublicationEntry, OutputSubscription } from "./output-executor-resources.ts"
import type { OutputCommand } from "./output-events.ts"
type Command = Extract<
  OutputCommand,
  {
    kind:
      | "Register"
      | "Unregister"
      | "OpenPublication"
      | "RevokePublication"
      | "ClosePublication"
      | "ReadReply"
      | "Drain"
  }
>
const register = (resources: OutputResources, command: Extract<Command, { kind: "Register" }>) => {
  const { deps } = resources
  const acquire = Effect.gen(function* () {
    const capabilities = yield* Schema.decodeUnknownEffect(SynthesisCapabilities)(deps.synthesis.capabilities).pipe(
      Effect.mapError(() => ({ code: "AudioUnavailable", message: "Incompatible speech synthesis capabilities" }))
    )
    if (!capabilities.languages.includes("en"))
      return yield* Effect.fail({ code: "AudioUnavailable", message: "English speech synthesis is unavailable" })
    return yield* deps.conversation
      .registerReplyDelivery({ completionMillis: command.completionMillis })
      .pipe(Effect.mapError(outputError))
  })
  return resources.start(
    "Register",
    command.operation,
    Effect.gen(function* () {
      const exit = yield* acquire.pipe(Effect.interruptible, Effect.exit)
      if (exit._tag === "Failure") {
        const outcome = resources.outcome(exit)
        const error =
          outcome.kind === "Failure"
            ? outcome.error
            : { code: "AudioUnavailable", message: "Audio output registration was interrupted" }
        yield* resources.post({ kind: "RegistrationFailed", operation: command.operation, error })
        yield* Deferred.fail(resources.attached, failed(error.code, error.message))
        return
      }
      const subscription = exit.value
      const entry: OutputSubscription = { subscription, started: Deferred.makeUnsafe<void>() }
      resources.subscriptions.set(subscription.registrationId, entry)
      yield* resources.post({
        kind: "Registered",
        operation: command.operation,
        registrationId: subscription.registrationId,
        snapshot: subscription.snapshot,
        outputEpoch: randomUUID()
      })
      entry.fiber = yield* Effect.gen(function* () {
        const observed = yield* subscription.updates.pipe(
          Stream.runForEach((update) => resources.post({ kind: "DeliveryUpdate", update, outputEpoch: randomUUID() })),
          Effect.interruptible,
          Effect.exit
        )
        const outcome = resources.outcome(observed)
        if (outcome.kind === "Failure")
          yield* resources.post({
            kind: "SubscriptionFailed",
            registrationId: subscription.registrationId,
            error: outcome.error
          })
      }).pipe(Effect.uninterruptible, Effect.forkIn(deps.scope, { startImmediately: true, uninterruptible: true }))
      yield* Deferred.succeed(entry.started, undefined)
      yield* Deferred.succeed(resources.attached, undefined)
    }).pipe(Effect.uninterruptible)
  )
}
const unregister = (resources: OutputResources, command: Extract<Command, { kind: "Unregister" }>) =>
  resources.run(
    "Unregister",
    command.operation,
    Effect.gen(function* () {
      if (command.delayMillis > 0) yield* Effect.sleep(command.delayMillis)
      const entry = resources.subscriptions.get(command.registrationId)
      if (entry !== undefined) {
        yield* Deferred.await(entry.started)
        if (entry.fiber !== undefined) yield* Fiber.interrupt(entry.fiber)
      }
      yield* resources.deps.conversation
        .unregisterReplyDelivery(command.registrationId)
        .pipe(Effect.mapError(outputError))
      resources.subscriptions.delete(command.registrationId)
      return { kind: "Unregistered", operation: command.operation, registrationId: command.registrationId } as const
    }),
    (error) => {
      recordVoiceDiagnostic(resources.deps.diagnostics, {
        cause: "failed",
        sessionId: resources.deps.sessionId,
        applied: true,
        errorCode: "AudioUnavailable"
      })
      return { kind: "UnregisterRejected", operation: command.operation, registrationId: command.registrationId, error }
    }
  )
const open = (resources: OutputResources, command: Extract<Command, { kind: "OpenPublication" }>) => {
  const entry: PublicationEntry = { key: command.key, revoked: false }
  resources.publications.set(command.operation, entry)
  const authorization = resources.deps.conversation.replyDeliveryAuthorization(command.key.ticket)
  return resources.start(
    "OpenPublication",
    command.operation,
    Effect.gen(function* () {
      const acquisition = Effect.suspend(() => {
        const connection = resources.deps.connection()
        if (connection === undefined)
          return Effect.fail({ code: "AudioUnavailable", message: "Reply media connection is unavailable" })
        return connection
          .openOutput(command.key.outputEpoch, {
            signal: authorization.signal,
            isAuthorized: () =>
              !entry.revoked &&
              outputAuthorized(resources.deps.current(), command.key, command.operation) &&
              authorization.isAuthorized()
          })
          .pipe(Effect.mapError(outputError))
      })
      const exit = yield* acquisition.pipe(
        withAuditSpan("voice.publication", command.key.ticket.responseId),
        Effect.interruptible,
        Effect.exit
      )
      if (exit._tag === "Success") {
        entry.handle = exit.value
        if (
          entry.revoked ||
          !outputAuthorized(resources.deps.current(), command.key, command.operation) ||
          !authorization.isAuthorized()
        )
          entry.handle.invalidate()
        yield* resources.post({
          kind: "PublicationOpened",
          operation: command.operation,
          key: command.key,
          publisherIdentity: entry.handle.publisherIdentity,
          trackSid: entry.handle.trackSid,
          now: yield* Clock.currentTimeMillis
        })
        return
      }
      const outcome = resources.outcome(exit)
      resources.publications.delete(command.operation)
      const error =
        outcome.kind === "Failure"
          ? outcome.error
          : { code: "AudioUnavailable", message: "Reply publication acquisition was interrupted" }
      yield* resources.post({ kind: "PublicationFailed", operation: command.operation, key: command.key, error })
    }).pipe(Effect.uninterruptible)
  )
}
const close = (resources: OutputResources, command: Extract<Command, { kind: "ClosePublication" }>) => {
  const operation = command.operation
  const entry = resources.publications.get(command.parentOperation)
  if (entry === undefined) return resources.post({ kind: "Released", operation })
  return resources.start(
    "ClosePublication",
    operation,
    Effect.gen(function* () {
      if (command.delayMillis > 0) yield* Effect.sleep(command.delayMillis)
      const exit = yield* Effect.suspend(() => entry.handle?.close() ?? Effect.void).pipe(Effect.exit)
      const outcome = resources.outcome(exit)
      if (outcome.kind !== "Success") {
        const error =
          outcome.kind === "Failure"
            ? outcome.error
            : { code: "AudioUnavailable", message: "Audio publication release was interrupted" }
        recordVoiceDiagnostic(resources.deps.diagnostics, {
          cause: "failed",
          sessionId: resources.deps.sessionId,
          applied: true,
          errorCode: "AudioUnavailable",
          responseId: entry.key.ticket.responseId,
          inputDeliveryId: entry.key.ticket.inputDeliveryId,
          outputEpoch: entry.key.outputEpoch
        })
        yield* resources.post({ kind: "WorkFailed", operation, key: entry.key, error })
        return
      }
      resources.publications.delete(command.parentOperation)
      yield* resources.post({ kind: "Released", operation })
    }).pipe(Effect.uninterruptible)
  )
}
const observed = (resources: OutputResources, command: Extract<Command, { kind: "ReadReply" }>) =>
  resources.run(
    "ReadReply",
    command.operation,
    Effect.sleep(command.delayMillis).pipe(
      Effect.andThen(resources.deps.conversation.reply(command.key.ticket.inputDeliveryId)),
      Effect.mapError(outputError),
      Effect.map(
        (reply) =>
          ({
            kind: "ReplyObserved",
            operation: command.operation,
            key: command.key,
            reply: { ...reply, languageSpans: (reply.languageSpans ?? []).map((span) => ({ ...span })) },
            phraseId: randomUUID()
          }) as const
      )
    ),
    (error) => ({ kind: "WorkFailed", operation: command.operation, key: command.key, error }),
    command.key.ticket.responseId
  )
export const executeReadyTimer = (
  resources: OutputResources,
  command: Extract<OutputCommand, { kind: "StartReadyTimer" }>
) =>
  resources.run(
    "ReadyTimer",
    command.operation,
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) => Effect.sleep(Math.max(0, command.deadlineAt - now))),
      Effect.as({ kind: "ReadyDeadline", operation: command.operation, key: command.key } as const)
    ),
    (error) => ({ kind: "WorkFailed", operation: command.operation, key: command.key, error }),
    command.key.ticket.responseId
  )
export const executePublication = (resources: OutputResources, command: Command): Effect.Effect<void> => {
  switch (command.kind) {
    case "Register":
      return register(resources, command)
    case "Unregister":
      return unregister(resources, command)
    case "OpenPublication":
      return open(resources, command)
    case "ClosePublication":
      return close(resources, command)
    case "RevokePublication":
      return Effect.sync(() => {
        const entry = resources.publications.get(command.publicationOperation)
        if (entry !== undefined) {
          entry.revoked = true
          entry.handle?.invalidate()
        }
      })
    case "ReadReply":
      return observed(resources, command)
    case "Drain":
      return resources.run(
        "Drain",
        command.operation,
        Effect.suspend(() => {
          const publication = resources.publications.get(command.publicationOperation)?.handle
          return publication === undefined
            ? Effect.fail({ code: "AudioUnavailable", message: "Reply publication is unavailable" })
            : publication
                .drain()
                .pipe(
                  Effect.mapError(outputError),
                  Effect.as({ kind: "Drained", operation: command.operation, key: command.key } as const)
                )
        }),
        (error) => ({ kind: "WorkFailed", operation: command.operation, key: command.key, error }),
        command.key.ticket.responseId
      )
  }
}
