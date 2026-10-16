import { randomBytes, randomUUID } from "node:crypto"
import { Clock, Deferred, Effect, Exit, Fiber, Redacted, Schema, Semaphore } from "effect"
import type { Scope } from "effect"
import { SessionId, failed } from "./contracts.ts"
import type { VoiceJoin, VoiceFailed } from "./contracts.ts"
import { StartVoiceRequest } from "./recovery-contracts.ts"
import { registryTransition, reserveSession } from "./registry-state.ts"
import type { RegistryState } from "./registry-state.ts"
import type { SessionHandle, SessionIdentity, SessionFactory, SessionRetention } from "./session-port.ts"
const capabilityBytes = 32
interface Resources {
  readonly result: Deferred.Deferred<Redacted.Redacted<VoiceJoin>, VoiceFailed>
  handle?: SessionHandle
  acquisition?: Fiber.Fiber<void>
}
export const makeVoiceRegistry = (factory: SessionFactory, scope: Scope.Scope) =>
  Effect.gen(function* () {
    let state: RegistryState = { retired: false, records: [] }
    const resources = new Map<string, Resources>()
    const writer = yield* Semaphore.make(1)
    const owned = <A, E>(work: Effect.Effect<A, E>) => work.pipe(writer.withPermits(1))
    const retention = (fact: SessionRetention) =>
      owned(
        Effect.sync(() => {
          state = registryTransition(state, { kind: "Retention", fact })
        })
      )
    const resourceSnapshot = owned(Effect.sync(() => [...resources.values()].map((resource) => ({ ...resource }))))
    const expireAll = Effect.gen(function* () {
      const snapshot = yield* resourceSnapshot
      const now = yield* Clock.currentTimeMillis
      yield* Effect.forEach(snapshot, (resource) => resource.handle?.expire(now) ?? Effect.void, { discard: true })
    })
    const completed = (id: string, resource: Resources, handle: SessionHandle, join: VoiceJoin) =>
      Effect.gen(function* () {
        const stale = yield* owned(
          Effect.gen(function* () {
            if (state.retired || resources.get(id) !== resource) return true
            resource.handle = handle
            state = registryTransition(state, { kind: "Ready", sessionId: id })
            const record = state.records.find((value) => value.sessionId === id)
            if (record?.status === "active") yield* Deferred.succeed(resource.result, Redacted.make(join))
            else yield* Deferred.fail(resource.result, failed("StartExpired", "The original voice session has ended"))
            return false
          })
        )
        if (stale) yield* handle.dispose()
      })
    const acquire = (identity: SessionIdentity, request: StartVoiceRequest, startedAt: number, resource: Resources) =>
      Effect.uninterruptibleMask((restore) =>
        restore(factory(identity, request, startedAt, retention)).pipe(
          Effect.exit,
          Effect.flatMap((exit) => {
            if (Exit.isSuccess(exit)) return completed(identity.sessionId, resource, exit.value.handle, exit.value.join)
            return owned(
              Effect.gen(function* () {
                if (resources.get(identity.sessionId) === resource) {
                  state = registryTransition(state, { kind: "Failed", sessionId: identity.sessionId })
                  resources.delete(identity.sessionId)
                }
                yield* Deferred.failCause(resource.result, exit.cause)
              })
            )
          })
        )
      )
    const reserve = (identity: SessionIdentity, request: StartVoiceRequest, startedAt: number) =>
      owned(
        Effect.gen(function* () {
          const decision = reserveSession(state, request, identity.sessionId)
          state = decision.state
          if (decision.result.kind === "Rejected") return yield* decision.result.error
          if (decision.result.kind === "Existing") {
            const existing = resources.get(decision.result.sessionId)
            if (existing === undefined) return yield* failed("SessionNotFound", "Voice session unavailable")
            return { result: existing.result, evicted: undefined }
          }
          const evicted = resources.get(decision.result.evicted ?? "")?.handle
          if (decision.result.evicted !== undefined) resources.delete(decision.result.evicted)
          const resource: Resources = { result: yield* Deferred.make<Redacted.Redacted<VoiceJoin>, VoiceFailed>() }
          resources.set(identity.sessionId, resource)
          resource.acquisition = yield* acquire(identity, request, startedAt, resource).pipe(Effect.forkIn(scope))
          return { result: resource.result, evicted }
        })
      ).pipe(Effect.uninterruptible)
    const start = (raw: StartVoiceRequest) =>
      Effect.gen(function* () {
        const request = yield* Schema.decodeUnknownEffect(StartVoiceRequest)(raw).pipe(
          Effect.mapError(() => failed("InvalidInput", "Invalid voice start payload"))
        )
        yield* expireAll
        const identity = {
          sessionId: randomUUID(),
          roomName: randomUUID(),
          participantIdentity: randomUUID(),
          controlToken: Redacted.make(randomBytes(capabilityBytes).toString("hex"))
        }
        const reservation = yield* reserve(identity, request, yield* Clock.currentTimeMillis)
        if (reservation.evicted !== undefined) yield* reservation.evicted.dispose().pipe(Effect.forkIn(scope))
        return Redacted.value(yield* Deferred.await(reservation.result))
      })
    const get = (raw: string) =>
      Effect.gen(function* () {
        const id = yield* Schema.decodeUnknownEffect(SessionId)(raw).pipe(
          Effect.mapError(() => failed("InvalidSession", "Invalid session identity"))
        )
        const handle = yield* owned(
          Effect.sync(() => (state.retired ? undefined : resources.get(id.toLowerCase())?.handle))
        )
        if (handle === undefined) return yield* failed("SessionNotFound", "Voice session unavailable")
        yield* handle.expire(yield* Clock.currentTimeMillis)
        return handle
      })
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const snapshot = yield* owned(
          Effect.sync(() => {
            state = registryTransition(state, { kind: "Retired" })
            return [...resources.values()].map((resource) => ({ ...resource }))
          })
        )
        yield* Effect.forEach(
          snapshot,
          (resource) => Deferred.fail(resource.result, failed("StartExpired", "Voice host stopped")),
          { discard: true }
        )
        yield* Effect.forEach(
          snapshot,
          (resource) => (resource.acquisition === undefined ? Effect.void : Fiber.interrupt(resource.acquisition)),
          { discard: true, concurrency: "unbounded" }
        )
        yield* Effect.forEach(snapshot, (resource) => resource.handle?.dispose() ?? Effect.void, {
          discard: true,
          concurrency: "unbounded"
        })
      })
    )
    return { start, get }
  })
