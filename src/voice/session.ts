import { randomUUID } from "node:crypto"
import { Clock, Effect, Exit, Fiber, Redacted, Scope } from "effect"
import { failed } from "./contracts.ts"
import type { SessionDependencies, SessionFactory, SessionHandle } from "./session-port.ts"
import { withinSessionPreparationDeadline } from "./session-preparation.ts"
import { makeSessionRuntime } from "./session-runtime.ts"
/** One mailbox owns lifecycle and projections. Capture resources can close while
 * already handed Conversation admissions continue in the host scope. */
export function createVoiceSession(deps: SessionDependencies): SessionFactory {
  return function acquireSession(identity, request, startedAt, retention) {
    return Effect.uninterruptibleMask(function interpretAcquisition(restore) {
      return Effect.gen(function* acquireSessionResources() {
        const captureScope = yield* Scope.fork(deps.hostScope)
        const sourceScope = yield* Scope.make()
        const sourceRelease = Scope.close(sourceScope, Exit.void)
        const source = yield* restore(
          withinSessionPreparationDeadline(
            startedAt,
            Effect.acquireRelease(
              deps.conversation
                .openInputSource()
                .pipe(Effect.mapError((error) => failed("InvalidInput", error.message))),
              (capability) => deps.conversation.closeInputSource(capability).pipe(Effect.ignore)
            ).pipe(Scope.provide(sourceScope))
          )
        ).pipe(Effect.onError(() => sourceRelease.pipe(Effect.andThen(Scope.close(captureScope, Exit.void)))))
        const activity = yield* restore(
          withinSessionPreparationDeadline(startedAt, deps.activity.open().pipe(Scope.provide(captureScope)))
        ).pipe(Effect.onError(() => sourceRelease.pipe(Effect.andThen(Scope.close(captureScope, Exit.void)))))
        const runtime = yield* makeSessionRuntime(
          deps,
          identity,
          request.muted,
          startedAt,
          captureScope,
          activity,
          source,
          sourceRelease,
          retention
        )
        const expire = (now: number) => runtime.post({ kind: "Expire", now }).pipe(Effect.asVoid, Effect.ignore)
        const renew = () =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) => runtime.post({ kind: "Renew", now })),
            Effect.asVoid
          )
        const handle: SessionHandle = {
          authorize: (token) =>
            token === Redacted.value(identity.controlToken)
              ? Effect.void
              : Effect.fail(failed("Unauthorized", "Invalid session capability")),
          snapshot: (after) =>
            runtime.reconcile().pipe(
              Effect.andThen(renew()),
              Effect.map(() => runtime.snapshot(after))
            ),
          mute: (muted) =>
            Clock.currentTimeMillis.pipe(
              Effect.flatMap((now) => runtime.post({ kind: "Mute", muted, now, requestId: randomUUID() })),
              Effect.map(() => runtime.snapshot(0))
            ),
          ready: (input) =>
            runtime.ready(input).pipe(
              Effect.andThen(renew()),
              Effect.map(() => runtime.snapshot(0))
            ),
          interrupt: (input) =>
            runtime.interrupt(input).pipe(
              Effect.andThen(renew()),
              Effect.map(() => runtime.snapshot(0))
            ),
          end: () => runtime.close().pipe(Effect.map(() => runtime.snapshot(0))),
          expire,
          dispose: runtime.dispose
        }
        yield* runtime.post({ kind: "InitializeExpiry" })
        const acquisition = yield* restore(
          deps.transport
            .open(identity, runtime.incoming, runtime.disconnected, runtime.joined)
            .pipe(Effect.tap((media) => runtime.attach(media.connection)))
        ).pipe(Effect.ensuring(runtime.acquisitionFinished), Effect.forkIn(deps.hostScope))
        yield* runtime.installAcquisition(acquisition)
        const acquired = yield* restore(Fiber.await(acquisition)).pipe(
          Effect.onError(() => Fiber.interrupt(acquisition).pipe(Effect.andThen(runtime.dispose())))
        )
        if (Exit.isFailure(acquired)) {
          const expired = runtime.current().phase !== "starting"
          yield* runtime.dispose()
          if (expired) return yield* failed("StartExpired", "The original voice session has ended")
          return yield* Effect.failCause(acquired.cause)
        }
        const opened = acquired.value
        yield* runtime.post({ kind: "Activated" })
        yield* expire(yield* Clock.currentTimeMillis)
        if (runtime.current().phase !== "active") {
          yield* runtime.awaitClosed
          yield* runtime.dispose()
          return yield* failed("StartExpired", "The original voice session has ended")
        }
        yield* Effect.addFinalizer(() => handle.dispose()).pipe(Effect.provideService(Scope.Scope, deps.hostScope))
        return {
          handle,
          join: {
            ...opened.join,
            backendIncarnationId: deps.admissions.backendIncarnationId,
            startRequestId: request.startRequestId,
            joinDeadlineAt: runtime.current().joinDeadlineAt,
            controlDeadlineAt: runtime.current().controlDeadlineAt,
            controlToken: Redacted.value(identity.controlToken)
          }
        }
      }).pipe(Scope.provide(deps.hostScope))
    })
  }
}
