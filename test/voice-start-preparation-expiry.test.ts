import { it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { fakeRecognitionLayer } from "../src/speech-recognition/index.ts"
import { fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import {
  Voice,
  SpeechActivity,
  fakeSpeechActivityLayer,
  VoiceLanguageConfiguration,
  defaultVoiceLanguageConfiguration,
  VoiceOutputConfiguration,
  defaultVoiceOutputSettings
} from "../src/voice/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { replyLayer } from "./reply-fixture.ts"
import { voiceTransportFixture } from "./voice-fixture.ts"
import { startVoiceRequest, voiceAdmissionsFixture } from "./voice-admission-fixture.ts"
for (const boundary of ["source", "activity"] as const) {
  it.effect(`expires startup during ${boundary} preparation and settles cleanup before releasing start callers`, () =>
    Effect.gen(function* () {
      const database = yield* Effect.promise(temporaryDatabase)
      const entered = yield* Deferred.make<void>()
      const cancelling = yield* Deferred.make<void>()
      const releaseCleanup = yield* Deferred.make<void>()
      const cleaned = yield* Deferred.make<void>()
      const captureClosed = yield* Deferred.make<void>()
      const transport = voiceTransportFixture()
      const conversation = replyLayer(database.path, fakeAnswerLayer(0))
      let first = true
      let sourceClosed = 0
      const block = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() =>
          Deferred.succeed(cancelling, undefined).pipe(
            Effect.andThen(Deferred.await(releaseCleanup)),
            Effect.andThen(Deferred.succeed(cleaned, undefined))
          )
        )
      )
      const controlledConversation = Layer.effect(
        Conversation,
        Effect.gen(function* () {
          const real = yield* Conversation
          return Conversation.of({
            ...real,
            openInputSource: () =>
              Effect.gen(function* () {
                const source = yield* real.openInputSource()
                if (boundary === "source" && first) {
                  first = false
                  yield* Deferred.succeed(entered, undefined)
                  yield* Deferred.await(releaseCleanup)
                }
                return source
              }).pipe(Effect.uninterruptible),
            closeInputSource: (source) =>
              real.closeInputSource(source).pipe(
                Effect.tap(() => Deferred.succeed(cleaned, undefined)),
                Effect.tap(() =>
                  Effect.sync(() => {
                    sourceClosed += 1
                  })
                )
              )
          })
        })
      ).pipe(Layer.provide(conversation))
      const activity = Layer.effect(
        SpeechActivity,
        Effect.gen(function* () {
          const real = yield* SpeechActivity
          return SpeechActivity.of({
            open: () =>
              Effect.gen(function* () {
                yield* Effect.addFinalizer(() => Deferred.succeed(captureClosed, undefined))
                if (boundary === "activity" && first) {
                  first = false
                  return yield* block
                }
                return yield* real.open()
              })
          })
        })
      ).pipe(Layer.provide(fakeSpeechActivityLayer))
      const application = Voice.configuredLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(VoiceLanguageConfiguration, defaultVoiceLanguageConfiguration),
            Layer.succeed(VoiceOutputConfiguration, defaultVoiceOutputSettings),
            controlledConversation,
            transport.layer,
            fakeRecognitionLayer(),
            fakeSynthesisLayer(),
            activity,
            voiceAdmissionsFixture().pipe(Layer.provide(conversation))
          )
        )
      )
      yield* Effect.gen(function* () {
        const voice = yield* Voice
        const scope = yield* Effect.scope
        const request = startVoiceRequest()
        const originalDone = yield* Deferred.make<void>()
        const duplicateDone = yield* Deferred.make<void>()
        const original = yield* voice.start(request).pipe(
          Effect.result,
          Effect.tap(() => Deferred.succeed(originalDone, undefined)),
          Effect.forkIn(scope)
        )
        yield* Deferred.await(entered)
        const duplicate = yield* voice.start(request).pipe(
          Effect.result,
          Effect.tap(() => Deferred.succeed(duplicateDone, undefined)),
          Effect.forkIn(scope)
        )
        yield* TestClock.adjust("10 seconds")
        if (boundary === "activity") {
          for (let poll = 0; !(yield* Deferred.isDone(cancelling)) && poll < 100; poll++) yield* Effect.yieldNow
          expect(yield* Deferred.isDone(cancelling)).toBe(true)
        }
        expect(yield* Deferred.isDone(cleaned)).toBe(false)
        expect(yield* Deferred.isDone(originalDone)).toBe(false)
        expect(yield* Deferred.isDone(duplicateDone)).toBe(false)
        expect(transport.opens()).toBe(0)
        expect(sourceClosed).toBe(0)
        yield* Deferred.succeed(releaseCleanup, undefined)
        const results = [yield* Fiber.join(original), yield* Fiber.join(duplicate)]
        expect(yield* Deferred.isDone(cleaned)).toBe(true)
        expect(sourceClosed).toBe(1)
        if (boundary === "activity") {
          expect(yield* Deferred.isDone(captureClosed)).toBe(true)
        }
        for (const result of results) {
          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure") expect(result.failure.code).toBe("StartExpired")
        }
        const replacement = yield* voice.start(startVoiceRequest())
        expect(transport.opens()).toBe(1)
        expect((yield* voice.snapshot(replacement.sessionId, 0)).status).toBe("active")
        yield* voice.end(replacement.sessionId)
      }).pipe(
        Effect.ensuring(Deferred.succeed(releaseCleanup, undefined)),
        Effect.scoped,
        Effect.provide(application),
        Effect.ensuring(Effect.promise(() => database.close()))
      )
    })
  )
}
