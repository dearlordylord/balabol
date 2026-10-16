import { it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vitest"
import { Voice, VoiceTransport } from "../src/voice/index.ts"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { fakeRecognitionLayer } from "../src/speech-recognition/index.ts"
import { fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import { replyLayer } from "./reply-fixture.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { voiceTransportFixture } from "./voice-fixture.ts"
import { startVoiceRequest, voiceAdmissionsFixture } from "./voice-admission-fixture.ts"

it.effect("expires duplicate start waiters during blocked acquisition and permits a fresh start after cleanup", () =>
  Effect.gen(function* () {
    const database = yield* Effect.promise(temporaryDatabase)
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const cleaned = yield* Deferred.make<void>()
    const fixture = voiceTransportFixture(false)
    let first = true
    const transport = Layer.effect(
      VoiceTransport,
      Effect.gen(function* () {
        const real = yield* VoiceTransport
        return VoiceTransport.of({
          open: (identity, frame, disconnected, connected) =>
            Effect.gen(function* () {
              const opened = yield* real.open(identity, frame, disconnected, connected)
              if (!first) return opened
              first = false
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release).pipe(
                Effect.onInterrupt(() =>
                  opened.connection.close().pipe(Effect.andThen(Deferred.succeed(cleaned, undefined)))
                )
              )
              return opened
            })
        })
      })
    ).pipe(Layer.provide(fixture.layer))
    const conversation = replyLayer(database.path, fakeAnswerLayer(0))
    const application = Voice.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          conversation,
          transport,
          fakeRecognitionLayer(),
          fakeSynthesisLayer(),
          voiceAdmissionsFixture().pipe(Layer.provide(conversation))
        )
      )
    )
    yield* Effect.gen(function* () {
      const voice = yield* Voice
      const callerScope = yield* Effect.scope
      const request = startVoiceRequest()
      const original = yield* voice.start(request).pipe(Effect.result, Effect.forkIn(callerScope))
      yield* Deferred.await(entered)
      const duplicate = yield* voice.start(request).pipe(Effect.result, Effect.forkIn(callerScope))
      yield* Effect.yieldNow
      expect(fixture.opens()).toBe(1)
      yield* TestClock.adjust("10 seconds")
      for (let poll = 0; !(yield* Deferred.isDone(cleaned)) && poll < 100; poll++) yield* Effect.yieldNow
      expect(yield* Deferred.isDone(cleaned)).toBe(true)
      expect(fixture.closed()).toBe(true)
      const firstResult = yield* Fiber.join(original)
      const duplicateResult = yield* Fiber.join(duplicate)
      expect(firstResult._tag).toBe("Failure")
      expect(duplicateResult._tag).toBe("Failure")
      if (firstResult._tag === "Failure") expect(firstResult.failure.code).toBe("StartExpired")
      if (duplicateResult._tag === "Failure") expect(duplicateResult.failure.code).toBe("StartExpired")
      const replacement = yield* voice.start(startVoiceRequest())
      expect(fixture.opens()).toBe(2)
      expect((yield* voice.snapshot(replacement.sessionId, 0)).status).toBe("active")
      yield* voice.end(replacement.sessionId)
    }).pipe(
      Effect.ensuring(Deferred.succeed(release, undefined)),
      Effect.scoped,
      Effect.provide(application),
      Effect.ensuring(Effect.promise(() => database.close()))
    )
  })
)
