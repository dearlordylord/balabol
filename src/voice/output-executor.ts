import { Deferred, Effect } from "effect"
import { outputError, makeOutputResources } from "./output-executor-resources.ts"
import type { OutputExecutorDependencies } from "./output-executor-resources.ts"
import { failed } from "./contracts.ts"
import type { VoiceFailed } from "./contracts.ts"
import type { OutputCommand } from "./output-events.ts"
import { executePublication, executeReadyTimer } from "./output-executor-publication.ts"
import { executeCapture, executeSynthesis } from "./output-executor-synthesis.ts"
export type { OutputExecutorDependencies } from "./output-executor-resources.ts"
type ResourceCommand = Exclude<OutputCommand, { kind: "Project" | "Trace" }>
export const makeOutputExecutor = (deps: OutputExecutorDependencies) => {
  const resources = makeOutputResources(deps)
  const acknowledgements = new Map<number, Deferred.Deferred<void, VoiceFailed>>()
  const interrupt = (command: Extract<ResourceCommand, { kind: "InterruptResponse" }>) =>
    Effect.suspend(() => {
      const acknowledgement = command.acknowledge ? Deferred.makeUnsafe<void, VoiceFailed>() : undefined
      if (acknowledgement !== undefined) acknowledgements.set(command.operation, acknowledgement)
      return resources.start(
        "InterruptResponse",
        command.operation,
        Effect.gen(function* () {
          const exit = yield* Effect.suspend(() => deps.conversation.interruptResponse(command.target)).pipe(
            Effect.mapError(outputError),
            Effect.interruptible,
            Effect.exit
          )
          const outcome = resources.outcome(exit)
          if (outcome.kind === "Success") {
            yield* resources.post({ kind: "InterruptApplied", operation: command.operation, target: command.target })
            if (acknowledgement !== undefined) yield* Deferred.succeed(acknowledgement, undefined)
            return
          }
          const error =
            outcome.kind === "Failure"
              ? outcome.error
              : { code: "AudioUnavailable", message: "Reply interruption was cancelled" }
          yield* resources.post({
            kind: "InterruptRejected",
            operation: command.operation,
            target: command.target,
            error
          })
          if (acknowledgement !== undefined) yield* Deferred.fail(acknowledgement, failed(error.code, error.message))
        }).pipe(Effect.uninterruptible)
      )
    })
  const consumeAck = (operation: number) =>
    Effect.sync(() => {
      const acknowledgement = acknowledgements.get(operation)
      acknowledgements.delete(operation)
      return acknowledgement === undefined
        ? Effect.fail(failed("AudioUnavailable", "Reply interruption acknowledgement is unavailable"))
        : Deferred.await(acknowledgement)
    })
  const settle = (command: Extract<ResourceCommand, { kind: "SettleDelivery" }>) =>
    resources.run(
      "Settlement",
      command.operation,
      deps.conversation
        .settleReplyDelivery({
          ...command.key.ticket,
          outcome: command.outcome,
          ...(command.error === null ? {} : { error: command.error })
        })
        .pipe(
          Effect.mapError(outputError),
          Effect.as({ kind: "DeliverySettled", operation: command.operation, key: command.key } as const)
        ),
      (error) => ({ kind: "DeliveryRejected", operation: command.operation, key: command.key, error })
    )
  const execute = (command: ResourceCommand): Effect.Effect<void> => {
    switch (command.kind) {
      case "StartReadyTimer":
        return executeReadyTimer(resources, command)
      case "Synthesize":
        return executeSynthesis(resources, command)
      case "Capture":
        return executeCapture(resources, command)
      case "ReleasePayload":
        return resources.releasePayload(command.payloadId)
      case "Cancel":
        return resources.cancel(command.operation)
      case "InterruptResponse":
        return interrupt(command)
      case "SettleDelivery":
        return settle(command)
      default:
        return executePublication(resources, command)
    }
  }
  return { execute, consumeAck, awaitAttached: Deferred.await(resources.attached), close: resources.close }
}
