import { Deferred, Effect, Fiber, Layer, Queue, Schema } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { fakeRecognitionLayer } from "../src/speech-recognition/index.ts"
import { fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import {
  voiceDiagnosticsLayer,
  VoiceDiagnosticRecord,
  Voice,
  VoiceTransport,
  SpeechActivity,
  fakeSpeechActivityLayer,
  defaultVoiceLanguageConfiguration,
  defaultVoiceOutputSettings
} from "../src/voice/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { voiceTransportFixture } from "./voice-fixture.ts"
import { outputInput, voiceOutputLayer, waitForOutput } from "./voice-output-fixture.ts"
import { startVoiceRequest } from "./voice-admission-fixture.ts"

for (const { intent, overflow } of [
  { intent: "continue", overflow: true },
  { intent: "continue", overflow: false },
  { intent: "mute", overflow: true },
  { intent: "end", overflow: true }
] as const)
  it(`keeps ${intent} intent through ${overflow ? "queue overflow" : "late classification without queue overflow"}`, async () => {
    const database = await temporaryDatabase()
    const transport = voiceTransportFixture()
    const writes: string[] = []
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const firstFinished = yield* Deferred.make<void>()
          const processed = yield* Queue.unbounded<void>()
          const activity = Layer.effect(
            SpeechActivity,
            Effect.gen(function* () {
              const real = yield* SpeechActivity
              return SpeechActivity.of({
                open: () =>
                  real.open().pipe(
                    Effect.map((stream) => {
                      let first = true
                      return {
                        reset: () => stream.reset(),
                        push: (frame) =>
                          Effect.suspend(() => {
                            if (!first)
                              return stream.push(frame).pipe(Effect.tap(() => Queue.offer(processed, undefined)))
                            first = false
                            const work = Deferred.succeed(entered, undefined).pipe(
                              Effect.andThen(Deferred.await(release)),
                              Effect.andThen(
                                stream.push(frame).pipe(Effect.map((windows) => [...windows, ...windows, ...windows]))
                              ),
                              Effect.ensuring(Deferred.succeed(firstFinished, undefined))
                            )
                            return intent === "end" ? Effect.uninterruptible(work) : work
                          })
                      }
                    })
                  )
              })
            })
          ).pipe(Layer.provide(fakeSpeechActivityLayer))
          const media = Layer.effect(
            VoiceTransport,
            Effect.gen(function* () {
              const real = yield* VoiceTransport
              return VoiceTransport.of({
                open: (...args) =>
                  real
                    .open(...args)
                    .pipe(
                      Effect.map((opened) => ({
                        ...opened,
                        connection: {
                          ...opened.connection,
                          openOutput: (...params) =>
                            opened.connection
                              .openOutput(...params)
                              .pipe(Effect.map((publication) => ({ ...publication, drain: () => Effect.never })))
                        }
                      }))
                    )
              })
            })
          ).pipe(Layer.provide(transport.layer))
          yield* Effect.gen(function* () {
            const voice = yield* Voice
            const conversation = yield* Conversation
            const joined = yield* voice.start(startVoiceRequest())
            yield* conversation.send(outputInput)
            const prepared = (yield* waitForOutput(voice, joined.sessionId, "AwaitingReady")).output
            if (prepared?.manifest == null) throw new Error("Missing output publication")
            yield* voice.ready(joined.sessionId, {
              responseId: prepared.responseId,
              outputEpoch: prepared.outputEpoch,
              trackSid: prepared.manifest.trackSid
            })
            expect((yield* waitForOutput(voice, joined.sessionId, "Playing")).output?.status).toBe("Playing")
            yield* transport.send(transport.audio(1200))
            yield* Deferred.await(entered).pipe(Effect.timeout("2 seconds"))
            if (overflow) for (let frame = 0; frame < 12; frame++) yield* transport.send(transport.audio(0))
            else yield* Effect.sleep(180)
            const snapshot = yield* voice.snapshot(joined.sessionId, 0)
            expect(snapshot.status).toBe("active")
            expect(snapshot.output?.status).toBe("Playing")
            expect(snapshot.events.filter((event) => event.kind === "Error" && event.code === "Overloaded")).toEqual([])
            expect(transport.closed()).toBe(false)
            if (intent === "end") {
              const ending = yield* Effect.forkChild(voice.end(joined.sessionId))
              let closing = yield* voice.snapshot(joined.sessionId, 0)
              for (let poll = 0; closing.status === "active" && poll < 100; poll++) {
                yield* Effect.sleep(5)
                closing = yield* voice.snapshot(joined.sessionId, 0)
              }
              expect(["closing", "ended"]).toContain(closing.status)
              expect(transport.publications[0]?.invalidated).toBe(true)
              const publishedFrames = transport.captured.length
              yield* Deferred.succeed(release, undefined)
              yield* Deferred.await(firstFinished)
              expect((yield* Fiber.join(ending)).status).toBe("ended")
              yield* transport.send(transport.audio(1200))
              const ended = yield* voice.snapshot(joined.sessionId, 0)
              expect(ended.status).toBe("ended")
              expect(ended.output?.status).toBe("Interrupted")
              expect(transport.captured).toHaveLength(publishedFrames)
              expect(transport.closed()).toBe(true)
              expect(transport.opens()).toBe(1)
              const records = Schema.decodeUnknownSync(Schema.Struct({ events: Schema.Array(VoiceDiagnosticRecord) }))(
                JSON.parse(writes.at(-1) ?? "{}")
              )
              expect(records.events.filter((item) => item.cause === "captureRecovered")).toEqual([])
              return
            }
            if (intent === "mute") yield* voice.mute(joined.sessionId, true)
            yield* Deferred.succeed(release, undefined)
            if (intent === "mute") {
              yield* Deferred.await(firstFinished)
              yield* Effect.sleep(10)
              const muted = yield* voice.snapshot(joined.sessionId, 0)
              expect(muted.status).toBe("active")
              expect(muted.muted).toBe(true)
              expect(muted.output?.status).toBe("Playing")
              expect(
                muted.events.filter((event) => event.kind === "Error" && event.code === "CaptureDiscontinuity")
              ).toEqual([])
              expect(transport.publications[0]?.invalidated).toBe(false)
              const records = Schema.decodeUnknownSync(Schema.Struct({ events: Schema.Array(VoiceDiagnosticRecord) }))(
                JSON.parse(writes.at(-1) ?? "{}")
              )
              expect(records.events.filter((item) => item.cause === "captureRecovered")).toEqual([])
              expect((yield* conversation.page({ limit: 100 })).messages.map((item) => item.role)).toEqual(["user"])
              expect(transport.opens()).toBe(1)
              return
            }
            let recovered = yield* voice.snapshot(joined.sessionId, 0)
            for (
              let attempt = 0;
              !recovered.events.some((event) => event.kind === "Error" && event.code === "CaptureDiscontinuity") &&
              attempt < 100;
              attempt++
            ) {
              yield* Effect.sleep(5)
              recovered = yield* voice.snapshot(joined.sessionId, 0)
            }
            expect(
              recovered.events.filter((event) => event.kind === "Error" && event.code === "CaptureDiscontinuity")
            ).toHaveLength(1)
            expect(recovered.output?.status).toBe("Playing")
            expect(recovered.status).toBe("active")
            expect((yield* conversation.page({ limit: 100 })).messages.map((item) => item.role)).toEqual(["user"])
            expect(transport.publications[0]?.invalidated).toBe(false)
            yield* Effect.yieldNow
            const diagnostic = Schema.decodeUnknownSync(Schema.Struct({ events: Schema.Array(VoiceDiagnosticRecord) }))(
              JSON.parse(writes.at(-1) ?? "{}")
            )
            expect(diagnostic.events.find((item) => item.cause === "captureRecovered")?.capturePressure).toMatchObject({
              droppedFrames: overflow ? 13 : 1,
              queueDepth: 0
            })
            for (let frame = 0; frame < 50; frame++)
              yield* transport.send(transport.audio(0)).pipe(Effect.andThen(Queue.take(processed)))
            for (let frame = 0; frame < 3; frame++)
              yield* transport.send(transport.audio(1200)).pipe(Effect.andThen(Queue.take(processed)))
            for (let frame = 0; frame < 50; frame++)
              yield* transport.send(transport.audio(0)).pipe(Effect.andThen(Queue.take(processed)))
            let page = yield* conversation.page({ limit: 100 })
            for (
              let attempt = 0;
              page.messages.filter((item) => item.role === "user").length < 2 && attempt < 200;
              attempt++
            ) {
              yield* Effect.sleep(5)
              page = yield* conversation.page({ limit: 100 })
            }
            expect(page.messages.filter((item) => item.role === "user")).toHaveLength(2)
            expect((yield* voice.snapshot(joined.sessionId, 0)).status).toBe("active")
            expect(transport.opens()).toBe(1)
          }).pipe(
            Effect.ensuring(Deferred.succeed(release, undefined)),
            Effect.scoped,
            Effect.provide(
              voiceOutputLayer(
                database.path,
                { ...transport, layer: media },
                fakeSynthesisLayer({ delayMillis: 0 }),
                fakeAnswerLayer(0),
                fakeRecognitionLayer(),
                defaultVoiceLanguageConfiguration,
                defaultVoiceOutputSettings,
                activity
              ).pipe(
                Layer.provide(
                  voiceDiagnosticsLayer({
                    write: async (value) => {
                      writes.push(value)
                    }
                  })
                )
              )
            )
          )
        })
      )
    } finally {
      await database.close()
    }
  })
