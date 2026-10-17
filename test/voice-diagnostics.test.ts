import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { Effect, Layer, Schema, Stream, Queue, Deferred } from "effect"
import { expect, it } from "vitest"
import {
  Voice,
  VoiceDiagnostics,
  voiceDiagnosticsLayer,
  voiceDiagnosticFile,
  VoiceDiagnosticRecord
} from "../src/voice/index.ts"
import type { VoiceDiagnosticInput } from "../src/voice/diagnostics.ts"
import { SpeechSynthesis, SpeechSynthesisFailed, fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import { fakeRecognitionLayer } from "../src/speech-recognition/index.ts"
import { diagnosticErrorCode } from "../src/voice/diagnostics.ts"
import { parseConfig } from "../src/bootstrap/index.ts"
import { Conversation, type ReplyDeliveryUpdate } from "../src/conversation/index.ts"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { replyLayer, waitForReply } from "./reply-fixture.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { voiceTransportFixture } from "./voice-fixture.ts"
import { voiceOutputLayer, waitForOutput, classifiedVoiceInput } from "./voice-output-fixture.ts"
import { startVoiceRequest, voiceAdmissionsFixture } from "./voice-admission-fixture.ts"
const identity = "11111111-1111-4111-8111-111111111111"
const Snapshot = Schema.Struct({
  run: Schema.String,
  wallAnchor: Schema.Number,
  dropped: Schema.Int,
  events: Schema.Array(VoiceDiagnosticRecord)
})
const snapshot = (value: string) => Schema.decodeUnknownSync(Snapshot)(JSON.parse(value))
it("keeps a bounded latest snapshot while a writer is blocked and aborts without awaiting it", async () => {
  const snapshots: string[] = []
  let release: (() => void) | undefined
  let signal: AbortSignal | undefined
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  let sink: VoiceDiagnostics["Service"] | undefined
  await Effect.runPromise(
    Effect.gen(function* () {
      sink = yield* VoiceDiagnostics
      sink.record({
        cause: "clientInterrupt",
        sessionId: identity,
        responseId: identity.toUpperCase(),
        inputDeliveryId: identity,
        outputEpoch: identity,
        priorStatus: "Playing",
        generation: 2,
        applied: false
      })
      for (let index = 0; index < 600; index++)
        sink.record({ cause: "backendSpeech", sessionId: identity, applied: true })
      expect(snapshots).toHaveLength(1)
      release?.()
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      expect(snapshots).toHaveLength(2)
      const latest = snapshot(snapshots[1] ?? "")
      expect(latest.events).toHaveLength(256)
      expect(latest.events.at(-1)?.sequence).toBe(601)
      expect(latest.dropped).toBe(345)
      expect(Buffer.byteLength(snapshots[1] ?? "")).toBeLessThanOrEqual(131072)
      expect(latest.events[0]?.session).toBe(createHash("sha256").update(identity).digest("hex").slice(0, 12))
      expect(snapshots.join("")).not.toContain(identity)
    }).pipe(
      Effect.provide(
        voiceDiagnosticsLayer({
          async write(value, abort) {
            snapshots.push(value)
            signal = abort
            await blocked
          }
        })
      )
    )
  )
  expect(signal?.aborted).toBe(true)
  sink?.record({ cause: "backendSpeech", sessionId: identity, applied: true })
  expect(snapshots).toHaveLength(2)
  await Effect.runPromise(
    Effect.gen(function* () {
      const diagnostics = yield* VoiceDiagnostics
      diagnostics.record({ cause: "captureError", sessionId: identity, applied: true })
    }).pipe(Effect.provide(voiceDiagnosticsLayer({ write: () => new Promise(() => {}) })))
  )
})
it("persists atomic private metadata and tolerates a failed writer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "balabol-diagnostics-"))
  const path = join(directory, "private", "backend.json")
  try {
    const file = voiceDiagnosticFile(path)
    await file.write('{"events":[]}', new AbortController().signal)
    expect(await readFile(path, "utf8")).toBe('{"events":[]}')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    const abort = new AbortController()
    abort.abort()
    await expect(file.write("replaced", abort.signal)).rejects.toThrow()
    expect(await readFile(path, "utf8")).toBe('{"events":[]}')
    await Effect.runPromise(
      Effect.gen(function* () {
        const diagnostics = yield* VoiceDiagnostics
        diagnostics.record({ cause: "captureError", sessionId: identity, applied: true })
        yield* Effect.yieldNow
        diagnostics.record({ cause: "captureError", sessionId: identity, applied: true })
      }).pipe(
        Effect.provide(
          voiceDiagnosticsLayer({
            write: async () => {
              throw new Error("disk unavailable")
            }
          })
        )
      )
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
it("distinguishes backend onset, explicit interruption and detachment through public Voice", async () => {
  for (const cause of [
    "backendSpeech",
    "clientInterrupt",
    "detach"
  ] satisfies readonly VoiceDiagnosticInput["cause"][]) {
    const database = await temporaryDatabase()
    const transport = voiceTransportFixture()
    const records: VoiceDiagnosticInput[] = []
    const layer = voiceOutputLayer(database.path, transport).pipe(
      Layer.provide(
        Layer.succeed(VoiceDiagnostics, {
          record(input) {
            records.push(input)
          }
        })
      )
    )
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const voice = yield* Voice
          const conversation = yield* Conversation
          const join = yield* voice.start(startVoiceRequest())
          const input = yield* conversation.send({ deliveryId: identity, text: "Fixture" })
          const waiting = yield* waitForOutput(voice, join.sessionId, "AwaitingReady")
          const output = waiting.output
          if (output === null || output.manifest === null) throw new Error("Expected owned publication")
          if (cause === "backendSpeech") {
            for (let frame = 0; frame < 3; frame++) yield* transport.send(transport.audio(1200))
            yield* waitForOutput(voice, join.sessionId, "Interrupted")
          } else if (cause === "clientInterrupt") {
            yield* voice.interrupt(join.sessionId, output)
            yield* voice.interrupt(join.sessionId, output)
          } else yield* voice.end(join.sessionId)
          const reply = yield* waitForReply(conversation, input.deliveryId)
          expect(reply.receipt?.outcome).toBe("interrupted")
          expect(records.some((record) => record.cause === cause && record.applied)).toBe(true)
          if (cause === "clientInterrupt")
            expect(records.some((record) => record.cause === cause && !record.applied)).toBe(true)
          expect(
            (yield* conversation.page({ limit: 10 })).messages.filter((message) => message.role === "user")
          ).toHaveLength(1)
        }).pipe(Effect.provide(layer), Effect.scoped)
      )
    } finally {
      await database.close()
    }
  }
})
it("a throwing diagnostics sink cannot prevent interruption or durable acceptance", async () => {
  const database = await temporaryDatabase()
  const transport = voiceTransportFixture()
  try {
    const layer = voiceOutputLayer(database.path, transport).pipe(
      Layer.provide(
        Layer.succeed(VoiceDiagnostics, {
          record() {
            throw new Error("diagnostics only")
          }
        })
      )
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const voice = yield* Voice
        const conversation = yield* Conversation
        const join = yield* voice.start(startVoiceRequest())
        const input = yield* conversation.send({ deliveryId: identity, text: "Fixture" })
        const waiting = yield* waitForOutput(voice, join.sessionId, "AwaitingReady")
        if (waiting.output === null) throw new Error("Missing publication")
        yield* voice.interrupt(join.sessionId, waiting.output)
        expect((yield* waitForReply(conversation, input.deliveryId)).receipt?.outcome).toBe("interrupted")
      }).pipe(Effect.provide(layer), Effect.scoped)
    )
  } finally {
    await database.close()
  }
})

it("enables diagnostics only through the explicit startup opt-in", async () => {
  for (const value of [undefined, "0", "true", "1"]) {
    const config = await Effect.runPromise(parseConfig(value === undefined ? {} : { BALABOL_VOICE_DIAGNOSTICS: value }))
    expect(config.voiceDiagnostics).toBe(value === "1")
  }
})
it("records audio failure separately from speech even when its durable receipt is interrupted", async () => {
  const database = await temporaryDatabase()
  const transport = voiceTransportFixture()
  const records: VoiceDiagnosticInput[] = []
  const synthesis = Layer.succeed(SpeechSynthesis, {
    capabilities: {
      languages: ["ru", "fr", "en"],
      input: "supplied-text",
      output: "streaming-pcm",
      encoding: "pcm-s16le",
      sampleRateHz: 24000,
      channels: 1,
      maxPhraseChars: 800,
      maxAudioFrames: 240000
    },
    synthesize: () => Stream.fail(new SpeechSynthesisFailed({ message: "fixture failure" }))
  })
  try {
    const layer = voiceOutputLayer(database.path, transport, synthesis).pipe(
      Layer.provide(
        Layer.succeed(VoiceDiagnostics, {
          record(input) {
            records.push(input)
          }
        })
      )
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const voice = yield* Voice
        const conversation = yield* Conversation
        const join = yield* voice.start(startVoiceRequest())
        const input = yield* conversation.send({ deliveryId: identity, text: "Fixture" })
        const waiting = yield* waitForOutput(voice, join.sessionId, "AwaitingReady")
        if (waiting.output?.manifest == null) throw new Error("Missing publication")
        yield* voice.ready(join.sessionId, {
          responseId: waiting.output.responseId,
          outputEpoch: waiting.output.outputEpoch,
          trackSid: waiting.output.manifest.trackSid
        })
        expect((yield* waitForOutput(voice, join.sessionId, "Failed")).output?.error?.code).toBe("AudioUnavailable")
        expect((yield* waitForReply(conversation, input.deliveryId)).receipt?.outcome).toBe("interrupted")
        expect(records.some((record) => record.cause === "failed" && record.applied)).toBe(true)
        expect(records.some((record) => record.cause === "backendSpeech")).toBe(false)
      }).pipe(Effect.provide(layer), Effect.scoped)
    )
  } finally {
    await database.close()
  }
})

it("ignores a replayed delivery projection without borrowing the active epoch", async () => {
  const database = await temporaryDatabase()
  const transport = voiceTransportFixture()
  const records: VoiceDiagnosticInput[] = []
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const injected = yield* Queue.unbounded<ReplyDeliveryUpdate>()
        const consumed = yield* Deferred.make<void>()
        let firstUpdate: ReplyDeliveryUpdate | undefined
        const conversation = replyLayer(database.path, fakeAnswerLayer(0))
        const observed = Layer.effect(
          Conversation,
          Effect.gen(function* () {
            const real = yield* Conversation
            return Conversation.of({
              ...real,
              registerReplyDelivery: (input) =>
                real.registerReplyDelivery(input).pipe(
                  Effect.map((registration) => ({
                    ...registration,
                    updates: Stream.merge(
                      registration.updates.pipe(
                        Stream.tap((update) =>
                          Effect.sync(() => {
                            if (firstUpdate === undefined && update.kind === "Started") firstUpdate = update
                          })
                        )
                      ),
                      Stream.fromQueue(injected).pipe(
                        Stream.flatMap((update) =>
                          Stream.make(update).pipe(
                            Stream.concat(Stream.fromEffect(Deferred.succeed(consumed, undefined)).pipe(Stream.drain))
                          )
                        )
                      )
                    )
                  }))
                )
            })
          })
        ).pipe(Layer.provide(conversation))
        const application = Voice.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              observed,
              transport.layer,
              fakeRecognitionLayer(),
              fakeSynthesisLayer(),
              voiceAdmissionsFixture().pipe(Layer.provide(conversation))
            )
          ),
          Layer.provideMerge(conversation),
          Layer.provide(
            Layer.succeed(VoiceDiagnostics, {
              record(input) {
                records.push(input)
              }
            })
          )
        )
        yield* Effect.gen(function* () {
          const voice = yield* Voice
          const durable = yield* Conversation
          const join = yield* voice.start(startVoiceRequest())
          yield* durable.send({ deliveryId: identity, text: "First fixture" })
          const first = (yield* waitForOutput(voice, join.sessionId, "AwaitingReady")).output
          yield* durable.send({ deliveryId: "22222222-2222-4222-8222-222222222222", text: "Second fixture" })
          const second = (yield* waitForOutput(voice, join.sessionId, "AwaitingReady")).output
          if (second?.manifest == null || firstUpdate?.kind !== "Started") throw new Error("Missing second output")
          expect(second.responseId).not.toBe(first?.responseId)
          records.length = 0
          yield* Queue.offer(injected, { ...firstUpdate, kind: "Invalidated", reason: "Interrupted" })
          yield* Deferred.await(consumed).pipe(Effect.timeout("2 seconds"))
          expect(records).toEqual([])
          expect((yield* voice.snapshot(join.sessionId, 0)).output).toEqual(second)
          yield* voice.ready(join.sessionId, {
            responseId: second.responseId,
            outputEpoch: second.outputEpoch,
            trackSid: second.manifest.trackSid
          })
          expect((yield* waitForOutput(voice, join.sessionId, "Delivered")).output?.status).toBe("Delivered")
          yield* voice.end(join.sessionId)
        }).pipe(Effect.scoped, Effect.provide(application))
      })
    )
  } finally {
    await database.close()
  }
})

it("records a pre-Final recognition failure without output or an accepted message", async () => {
  const input = await Effect.runPromise(classifiedVoiceInput())
  const database = await temporaryDatabase()
  const transport = voiceTransportFixture()
  const records: VoiceDiagnosticInput[] = []
  try {
    const recognition = fakeRecognitionLayer({
      languages: ["ru", "fr", "en"],
      scripts: [{ events: [], delayMillis: 0, failure: "private synthetic failure text" }]
    })
    const layer = voiceOutputLayer(
      database.path,
      transport,
      fakeSynthesisLayer(),
      fakeAnswerLayer(0),
      recognition,
      undefined,
      undefined,
      input.layer
    ).pipe(
      Layer.provide(
        Layer.succeed(VoiceDiagnostics, {
          record(input) {
            records.push(input)
          }
        })
      )
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const voice = yield* Voice
        const conversation = yield* Conversation
        const join = yield* voice.start(startVoiceRequest())
        for (let index = 0; index < 3; index++) yield* input.send(transport, transport.audio(1200))
        for (let index = 0; index < 50; index++) yield* input.send(transport, transport.audio(0))
        let snapshot = yield* voice.snapshot(join.sessionId, 0)
        for (let index = 0; !snapshot.events.some((event) => event.kind === "Error") && index < 100; index++) {
          yield* Effect.sleep(5)
          snapshot = yield* voice.snapshot(join.sessionId, 0)
        }
        expect(snapshot.events.some((event) => event.kind === "Error" && event.code === "RecognitionFailed")).toBe(true)
        expect(snapshot.output).toBeNull()
        expect((yield* conversation.page({ limit: 10 })).messages).toEqual([])
        expect(records.some((record) => record.cause === "recognitionStarted")).toBe(true)
        expect(
          records.some(
            (record) =>
              record.cause === "sessionError" &&
              record.errorCode === "RecognitionFailed" &&
              record.recognitionReason === "Other"
          )
        ).toBe(true)
        expect(JSON.stringify(records)).not.toContain("private synthetic")
        expect(diagnosticErrorCode("untrusted arbitrary text")).toBe("Other")
        expect(diagnosticErrorCode("InvalidRecognition")).toBe("InvalidRecognition")
      }).pipe(Effect.provide(layer), Effect.scoped)
    )
  } finally {
    await database.close()
  }
})
