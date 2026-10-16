import { Deferred, Effect, Fiber } from "effect"
import { expect, it } from "vitest"
import type { SynthesisAudio } from "../src/speech-synthesis/index.ts"
import { openLiveKitOutput, type ReplyPublisher } from "../src/voice/livekit-output.ts"

it("retires a publication whose exact authorization is revoked while native publish awaits", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const permit = new AbortController()
        const unpublished: string[] = []
        const publisher: ReplyPublisher = {
          publishTrack: () =>
            Effect.runPromise(
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as({ sid: "TR_controlled" })
              )
            ),
          unpublishTrack: async (sid) => {
            unpublished.push(sid)
          }
        }
        const scope = yield* Effect.scope
        const opening = yield* openLiveKitOutput(
          publisher,
          scope,
          "publisher",
          "epoch",
          { signal: permit.signal, isAuthorized: () => !permit.signal.aborted },
          () => Effect.void
        ).pipe(Effect.result, Effect.forkChild)
        yield* Deferred.await(entered)
        permit.abort()
        yield* Deferred.succeed(release, undefined)
        const result = yield* Fiber.join(opening)
        expect(result._tag).toBe("Failure")
        expect(unpublished).toEqual(["TR_controlled"])
      })
    )
  )
})

it("revocation fails native capture and drain rather than treating a cleared queue as successful playback", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const permit = new AbortController()
        const publisher: ReplyPublisher = {
          publishTrack: async () => ({ sid: "TR_capture" }),
          unpublishTrack: async () => {}
        }
        const scope = yield* Effect.scope
        const output = yield* openLiveKitOutput(
          publisher,
          scope,
          "publisher",
          "epoch",
          { signal: permit.signal, isAuthorized: () => !permit.signal.aborted },
          () => Effect.void
        )
        const audio: SynthesisAudio = {
          encoding: "pcm-s16le" as const,
          channels: 1 as const,
          sampleRateHz: 24000,
          sampleFrames: 1200,
          bytes: new Uint8Array(2400)
        }
        yield* output.capture(audio)
        yield* output.capture(audio)
        let finished = false
        const capture = yield* output.capture(audio).pipe(
          Effect.result,
          Effect.tap(() =>
            Effect.sync(() => {
              finished = true
            })
          ),
          Effect.forkChild
        )
        let drained = false
        const draining = yield* output.drain().pipe(
          Effect.result,
          Effect.tap(() =>
            Effect.sync(() => {
              drained = true
            })
          ),
          Effect.forkChild
        )
        yield* Effect.sleep(20)
        expect(drained).toBe(false)
        expect(finished).toBe(false)
        permit.abort()
        expect((yield* Fiber.join(capture))._tag).toBe("Failure")
        expect((yield* Fiber.join(draining))._tag).toBe("Failure")
        expect((yield* output.drain().pipe(Effect.result))._tag).toBe("Failure")
        expect(
          (yield* output
            .capture({
              encoding: "pcm-s16le",
              channels: 1,
              sampleRateHz: 24000,
              sampleFrames: 240,
              bytes: new Uint8Array(480)
            })
            .pipe(Effect.result))._tag
        ).toBe("Failure")
        yield* output.close()
      })
    )
  )
})
