import { Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { fakeRecognitionLayer } from "../src/speech-recognition/index.ts"
import { fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import { Voice, VoiceTransport } from "../src/voice/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { replyLayer } from "./reply-fixture.ts"
import { voiceTransportFixture } from "./voice-fixture.ts"
import { startVoiceRequest, voiceAdmissionsFixture } from "./voice-admission-fixture.ts"

const observeCompletion = <A, E, R>(work: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const completion = yield* Deferred.make<Exit.Exit<A, E>>()
    const fiber = yield* work.pipe(
      Effect.exit,
      Effect.flatMap((exit) => Deferred.succeed(completion, exit)),
      Effect.forkIn(yield* Effect.scope)
    )
    return { fiber, await: Deferred.await(completion) }
  })
const controlledTransport = (blockAcquire: boolean, blockRelease: boolean, lateAcquire: boolean) =>
  Effect.gen(function* () {
    const fixture = voiceTransportFixture(false)
    const acquiring = yield* Deferred.make<string>()
    const acquired = yield* Deferred.make<void>()
    const releasing = yield* Deferred.make<void>()
    const released = yield* Deferred.make<void>()
    const disposed = yield* Deferred.make<void>()
    if (!blockAcquire) yield* Deferred.succeed(acquired, undefined)
    if (!blockRelease) yield* Deferred.succeed(released, undefined)
    const layer = Layer.effect(
      VoiceTransport,
      Effect.gen(function* () {
        const real = yield* VoiceTransport
        return VoiceTransport.of({
          open: (identity, frame, disconnected, connected) =>
            Effect.gen(function* () {
              const opened = yield* real.open(identity, frame, disconnected, connected)
              const dispose = opened.connection.close().pipe(Effect.andThen(Deferred.succeed(disposed, undefined)))
              yield* Deferred.succeed(acquiring, identity.sessionId)
              yield* Deferred.await(acquired).pipe(Effect.onInterrupt(() => dispose))
              return {
                ...opened,
                connection: {
                  ...opened.connection,
                  close: () =>
                    Deferred.succeed(releasing, undefined).pipe(
                      Effect.andThen(Deferred.await(released)),
                      Effect.andThen(dispose)
                    )
                }
              }
            }).pipe(lateAcquire ? Effect.uninterruptible : Effect.interruptible)
        })
      })
    ).pipe(Layer.provide(fixture.layer))
    return { fixture, acquiring, acquired, releasing, released, disposed, layer }
  })
type ControlledTransport = Effect.Success<ReturnType<typeof controlledTransport>>
const withRace = async (
  blockAcquire: boolean,
  blockRelease: boolean,
  use: (
    transport: ControlledTransport,
    serviceScope: Scope.Closeable
  ) => Effect.Effect<void, unknown, Voice | Conversation | Scope.Scope>,
  lateAcquire = false
) => {
  const database = await temporaryDatabase()
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* controlledTransport(blockAcquire, blockRelease, lateAcquire)
        const conversation = replyLayer(database.path, fakeAnswerLayer(0))
        const application = Voice.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              conversation,
              transport.layer,
              fakeRecognitionLayer(),
              fakeSynthesisLayer(),
              voiceAdmissionsFixture().pipe(Layer.provide(conversation))
            )
          ),
          Layer.provideMerge(conversation)
        )
        const serviceScope = yield* Scope.make()
        const context = yield* Layer.buildWithScope(application, serviceScope)
        yield* use(transport, serviceScope).pipe(
          Effect.ensuring(Deferred.succeed(transport.acquired, undefined)),
          Effect.ensuring(Deferred.succeed(transport.released, undefined)),
          Effect.scoped,
          Effect.provide(context),
          Effect.ensuring(Scope.close(serviceScope, Exit.void))
        )
      })
    )
  } finally {
    await database.close()
  }
}

it("coalesces concurrent identical starts into one media acquisition", () =>
  withRace(true, false, (transport) =>
    Effect.gen(function* () {
      const voice = yield* Voice
      const request = startVoiceRequest()
      const first = yield* voice.start(request).pipe(Effect.forkIn(yield* Effect.scope))
      yield* Deferred.await(transport.acquiring)
      const second = yield* voice.start(request).pipe(Effect.forkIn(yield* Effect.scope))
      yield* Effect.yieldNow
      expect(transport.fixture.opens()).toBe(1)
      expect(second.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(transport.acquired, undefined)
      const original = yield* Fiber.join(first)
      expect(yield* Fiber.join(second)).toEqual(original)
      expect(transport.fixture.opens()).toBe(1)
      yield* voice.end(original.sessionId)
    })
  ))
it("rejects conflicting start keys while media acquisition remains blocked", () =>
  withRace(true, false, (transport) =>
    Effect.gen(function* () {
      const voice = yield* Voice
      const request = startVoiceRequest()
      const first = yield* voice.start(request).pipe(Effect.forkIn(yield* Effect.scope))
      yield* Deferred.await(transport.acquiring)
      const conflict = yield* observeCompletion(voice.start(startVoiceRequest()).pipe(Effect.result))
      const conflicting = yield* conflict.await.pipe(Effect.flatten, Effect.timeout("500 millis"))
      expect(conflicting._tag).toBe("Failure")
      if (conflicting._tag === "Failure") expect(conflicting.failure.code).toBe("VoiceBusy")
      const mutation = yield* observeCompletion(voice.start({ ...request, muted: true }).pipe(Effect.result))
      const changed = yield* mutation.await.pipe(Effect.flatten, Effect.timeout("500 millis"))
      expect(changed._tag).toBe("Failure")
      if (changed._tag === "Failure") expect(changed.failure.code).toBe("StartConflict")
      expect(first.pollUnsafe()).toBeUndefined()
      expect(transport.fixture.opens()).toBe(1)
      yield* Deferred.succeed(transport.acquired, undefined)
      yield* voice.end((yield* Fiber.join(first)).sessionId)
    })
  ))
it("processes controls and ignores late media callbacks while end awaits physical release", () =>
  withRace(false, true, (transport) =>
    Effect.gen(function* () {
      const voice = yield* Voice
      const conversation = yield* Conversation
      const joined = yield* voice.start(startVoiceRequest())
      transport.fixture.joined()
      const ending = yield* voice.end(joined.sessionId).pipe(Effect.forkIn(yield* Effect.scope))
      yield* Deferred.await(transport.releasing).pipe(Effect.timeout("2 seconds"))
      expect(ending.pollUnsafe()).toBeUndefined()
      expect(transport.fixture.closed()).toBe(false)
      expect((yield* voice.snapshot(joined.sessionId, 0).pipe(Effect.timeout("500 millis"))).status).toBe("ended")
      yield* voice.authorize(joined.sessionId, joined.controlToken).pipe(Effect.timeout("500 millis"))
      expect((yield* voice.mute(joined.sessionId, true).pipe(Effect.timeout("500 millis"))).status).toBe("ended")
      transport.fixture.joined()
      transport.fixture.disconnect()
      yield* transport.fixture.send(transport.fixture.audio(1200))
      const snapshot = yield* voice.snapshot(joined.sessionId, 0).pipe(Effect.timeout("500 millis"))
      expect(snapshot.status).toBe("ended")
      expect((yield* conversation.page({ limit: 100 })).messages).toEqual([])
      expect(ending.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(transport.released, undefined)
      expect((yield* Fiber.join(ending)).status).toBe("ended")
      expect(transport.fixture.closed()).toBe(true)
    })
  ))

it("settles outer start callers when their Voice service lifetime closes during acquisition", () =>
  withRace(true, false, (transport, serviceScope) =>
    Effect.gen(function* () {
      const voice = yield* Voice
      const request = startVoiceRequest()
      const first = yield* observeCompletion(voice.start(request))
      yield* Deferred.await(transport.acquiring)
      const duplicate = yield* observeCompletion(voice.start(request))
      yield* Effect.yieldNow
      const closing = yield* observeCompletion(Scope.close(serviceScope, Exit.void))
      expect(Exit.isSuccess(yield* closing.await.pipe(Effect.timeout("2 seconds")))).toBe(true)
      expect(Exit.isFailure(yield* first.await.pipe(Effect.timeout("500 millis")))).toBe(true)
      expect(Exit.isFailure(yield* duplicate.await.pipe(Effect.timeout("500 millis")))).toBe(true)
      expect(transport.fixture.closed()).toBe(true)
      expect((yield* Effect.flip(voice.start(startVoiceRequest()))).code).toBe("VoiceBusy")
      transport.fixture.joined()
      transport.fixture.disconnect()
      yield* Deferred.succeed(transport.acquired, undefined)
      expect(transport.fixture.opens()).toBe(1)
    })
  ))

it("closes a late acquired connection when disconnect precedes readiness and ignores late join", () =>
  withRace(
    true,
    false,
    (transport) =>
      Effect.gen(function* () {
        const voice = yield* Voice
        const request = startVoiceRequest()
        const starting = yield* observeCompletion(voice.start(request))
        yield* Deferred.await(transport.acquiring)
        transport.fixture.disconnect()
        transport.fixture.joined()
        yield* Deferred.succeed(transport.acquired, undefined)
        const result = yield* starting.await.pipe(Effect.timeout("2 seconds"))
        yield* Deferred.await(transport.disposed).pipe(Effect.timeout("2 seconds"))
        expect(transport.fixture.closed()).toBe(true)
        if (Exit.isSuccess(result)) {
          expect((yield* voice.snapshot(result.value.sessionId, 0)).status).toBe("ended")
        }
        const next = yield* voice.start(startVoiceRequest()).pipe(Effect.timeout("2 seconds"))
        expect(transport.fixture.opens()).toBe(2)
        expect((yield* voice.snapshot(next.sessionId, 0)).status).toBe("active")
        yield* voice.end(next.sessionId)
      }),
    true
  ))
