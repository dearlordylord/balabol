import { startVoiceRequest } from "./voice-admission-fixture.ts"
import { it as effectIt } from "@effect/vitest"
import { Effect, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import { expect, it } from "vitest"
import { SpeechSynthesis, SpeechSynthesisFailed, fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import type { SynthesisEvent, SynthesisRequest } from "../src/speech-synthesis/index.ts"
import { Voice } from "../src/voice/index.ts"
import { Conversation } from "../src/conversation/index.ts"
import { waitForReply } from "./reply-fixture.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { voiceTransportFixture } from "./voice-fixture.ts"
import { voiceOutputLayer, withVoiceOutput, outputInput, waitForOutput } from "./voice-output-fixture.ts"
const badProvider = (events: (request: SynthesisRequest) => SynthesisEvent[], maxAudioFrames = 240000) =>
  Layer.succeed(SpeechSynthesis, {
    capabilities: {
      input: "supplied-text",
      output: "streaming-pcm",
      languages: ["ru", "fr", "en"],
      encoding: "pcm-s16le",
      sampleRateHz: 24000,
      channels: 1,
      maxPhraseChars: 800,
      maxAudioFrames
    },
    synthesize: (request) => Stream.fromIterable(events(request))
  })
const chunk = (request: SynthesisRequest, sequence = 0): SynthesisEvent => ({
  ...request,
  kind: "Chunk",
  sequence,
  audio: { encoding: "pcm-s16le", sampleRateHz: 24000, channels: 1, sampleFrames: 1200, bytes: new Uint8Array(2400) }
})
const completed = (request: SynthesisRequest, sequence = 1): SynthesisEvent => ({
  ...request,
  kind: "Completed",
  sequence
})
const scenarios: ReadonlyArray<{ name: string; events: (request: SynthesisRequest) => SynthesisEvent[] }> = [
  { name: "completion before PCM", events: (request) => [completed(request, 0)] },
  { name: "missing completion", events: (request) => [chunk(request)] },
  { name: "duplicate completion", events: (request) => [chunk(request), completed(request), completed(request)] },
  { name: "PCM after completion", events: (request) => [chunk(request), completed(request), chunk(request, 1)] },
  {
    name: "wrong response identity",
    events: (request) => [chunk({ ...request, responseId: "22222222-2222-4222-8222-222222222222" }), completed(request)]
  },
  { name: "sequence gap", events: (request) => [chunk(request, 1), completed(request, 2)] },
  {
    name: "misaligned PCM bytes",
    events: (request) => [
      {
        ...request,
        kind: "Chunk",
        sequence: 0,
        audio: { encoding: "pcm-s16le", sampleRateHz: 24000, channels: 1, sampleFrames: 1200, bytes: new Uint8Array(1) }
      }
    ]
  },
  {
    name: "aggregate phrase PCM over capacity",
    events: (request) => Array.from({ length: 201 }, (_, sequence) => chunk(request, sequence))
  }
]
for (const scenario of scenarios)
  it(`reports the failure and preserves collected text after ${scenario.name}`, () =>
    withVoiceOutput(
      () =>
        Effect.gen(function* () {
          const voice = yield* Voice
          const conversation = yield* Conversation
          const join = yield* voice.start(startVoiceRequest())
          yield* conversation.send(outputInput)
          const waiting = yield* waitForOutput(voice, join.sessionId, "AwaitingReady")
          const output = waiting.output
          if (output?.manifest == null) throw new Error("Missing publication")
          yield* voice.ready(join.sessionId, {
            responseId: output.responseId,
            outputEpoch: output.outputEpoch,
            trackSid: output.manifest.trackSid
          })
          const failed = yield* waitForOutput(voice, join.sessionId, "Failed")
          expect(failed.output?.error?.code).toBe("AudioUnavailable")
          const reply = yield* waitForReply(conversation, outputInput.deliveryId)
          expect(reply.state).toBe("Failed")
          expect(reply.error).toEqual(failed.output?.error)
          expect(reply.text).toBe("This is a fixture reply.")
          expect(reply.receipt?.outcome).toBe("interrupted")
        }),
      badProvider(scenario.events)
    ))
effectIt.effect("a missing readiness acknowledgement expires without losing generated text", () =>
  Effect.gen(function* () {
    const database = yield* Effect.promise(temporaryDatabase)
    yield* Effect.addFinalizer(() => Effect.promise(database.close))
    const transport = voiceTransportFixture()
    yield* Effect.gen(function* () {
      const voice = yield* Voice
      const conversation = yield* Conversation
      const join = yield* voice.start(startVoiceRequest())
      yield* conversation.send(outputInput)
      yield* TestClock.adjust(1)
      expect((yield* voice.snapshot(join.sessionId, 0)).output?.status).toBe("AwaitingReady")
      yield* TestClock.adjust(6000)
      expect((yield* voice.snapshot(join.sessionId, 0)).output?.status).toBe("Failed")
      const reply = yield* waitForReply(conversation, outputInput.deliveryId)
      expect(reply.receipt?.outcome).toBe("interrupted")
      expect(reply.text).toBe("This is a fixture reply.")
      expect(transport.captured).toEqual([])
    }).pipe(Effect.provide(voiceOutputLayer(database.path, transport)))
  })
)
it("rejects incompatible language capability before acquiring any media", async () => {
  const database = await temporaryDatabase()
  const transport = voiceTransportFixture()
  try {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Voice
        })
      ).pipe(
        Effect.provide(voiceOutputLayer(database.path, transport, fakeSynthesisLayer({ languages: ["ja"] }))),
        Effect.result
      )
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure" && result.failure._tag === "VoiceFailed")
      expect(result.failure.code).toBe("InvalidLanguageConfiguration")
    expect(transport.opens()).toBe(0)
  } finally {
    await database.close()
  }
})
effectIt.effect("the Conversation delivery deadline fences late synthesis and owns one interrupted receipt", () =>
  Effect.gen(function* () {
    const database = yield* Effect.promise(temporaryDatabase)
    yield* Effect.addFinalizer(() => Effect.promise(database.close))
    const transport = voiceTransportFixture()
    yield* Effect.gen(function* () {
      const voice = yield* Voice
      const conversation = yield* Conversation
      const join = yield* voice.start(startVoiceRequest())
      yield* conversation.send(outputInput)
      yield* TestClock.adjust(1)
      const output = (yield* voice.snapshot(join.sessionId, 0)).output
      if (output?.manifest == null) throw new Error("Missing publication")
      yield* voice.ready(join.sessionId, {
        responseId: output.responseId,
        outputEpoch: output.outputEpoch,
        trackSid: output.manifest.trackSid
      })
      // Keep control alive so its lease expiry cannot substitute for the reply deadline.
      yield* TestClock.adjust(20000)
      expect((yield* voice.snapshot(join.sessionId, 0)).status).toBe("active")
      yield* TestClock.adjust(11000)
      const snapshot = yield* voice.snapshot(join.sessionId, 0)
      expect(snapshot.status).toBe("active")
      expect(snapshot.output?.status).toBe("Failed")
      expect(snapshot.output?.error?.code).toBe("AudioUnavailable")
      const turn = yield* conversation.currentTurn()
      expect(turn?.reply.state).toBe("Failed")
      expect(turn?.reply.error?.reason).toBe("DeliveryDeadline")
      expect(turn?.reply.text).toBe("This is a fixture reply.")
      expect(turn?.reply.receipt?.outcome).toBe("interrupted")
      // Retire unrelated recurring lease polling before checking the late provider boundary.
      yield* voice.end(join.sessionId)
      yield* TestClock.adjust(60000)
      expect(transport.captured).toEqual([])
      expect((yield* conversation.page({ limit: 100 })).messages).toHaveLength(2)
    }).pipe(Effect.provide(voiceOutputLayer(database.path, transport, fakeSynthesisLayer({ delayMillis: 60000 }))))
  })
)

it("honors the selected provider's longer phrase audio bound without truncation", () =>
  withVoiceOutput(
    (transport) =>
      Effect.gen(function* () {
        const voice = yield* Voice
        const conversation = yield* Conversation
        const join = yield* voice.start(startVoiceRequest())
        yield* conversation.send(outputInput)
        const waiting = yield* waitForOutput(voice, join.sessionId, "AwaitingReady")
        const output = waiting.output
        if (output?.manifest == null) throw new Error("Missing publication")
        yield* voice.ready(join.sessionId, {
          responseId: output.responseId,
          outputEpoch: output.outputEpoch,
          trackSid: output.manifest.trackSid
        })
        expect((yield* waitForOutput(voice, join.sessionId, "Delivered")).output?.status).toBe("Delivered")
        expect(transport.captured.reduce((total, audio) => total + audio.frames, 0)).toBe(241200)
        expect((yield* conversation.reply(outputInput.deliveryId)).receipt?.outcome).toBe("completed")
      }),
    badProvider(
      (request) => [...Array.from({ length: 201 }, (_, sequence) => chunk(request, sequence)), completed(request, 201)],
      480000
    )
  ))

it("closes failed partial audio, retains useful text, and allows a healthy fresh reply", () => {
  let calls = 0
  const synthesis = Layer.effect(
    SpeechSynthesis,
    Effect.gen(function* () {
      const provider = yield* SpeechSynthesis
      return SpeechSynthesis.of({
        capabilities: provider.capabilities,
        synthesize: (request) => {
          calls += 1
          return calls === 1
            ? Stream.concat(
                Stream.succeed(chunk(request)),
                Stream.fail(new SpeechSynthesisFailed({ message: "Local synthesis process failed" }))
              )
            : provider.synthesize(request)
        }
      })
    })
  ).pipe(Layer.provide(fakeSynthesisLayer({ delayMillis: 0 })))
  return withVoiceOutput(
    (transport) =>
      Effect.gen(function* () {
        const voice = yield* Voice
        const conversation = yield* Conversation
        const join = yield* voice.start(startVoiceRequest())
        for (const deliveryId of [outputInput.deliveryId, crypto.randomUUID()]) {
          yield* conversation.send({ deliveryId, text: "Please reply" })
          const waiting = yield* waitForOutput(voice, join.sessionId, "AwaitingReady")
          const output = waiting.output
          if (output?.manifest == null) throw new Error("Missing publication")
          yield* voice.ready(join.sessionId, {
            responseId: output.responseId,
            outputEpoch: output.outputEpoch,
            trackSid: output.manifest.trackSid
          })
          const expected = deliveryId === outputInput.deliveryId ? "Failed" : "Delivered"
          expect((yield* waitForOutput(voice, join.sessionId, expected)).output?.status).toBe(expected)
          expect(
            transport.publications.find((publication) => publication.outputEpoch === output.outputEpoch)?.closed
          ).toBe(true)
          const reply = yield* waitForReply(conversation, deliveryId)
          expect(reply.receipt?.text).toBe("This is a fixture reply.")
          expect(reply.receipt?.outcome).toBe(expected === "Failed" ? "interrupted" : "completed")
        }
        expect((yield* conversation.page({ limit: 100 })).messages).toHaveLength(4)
      }),
    synthesis
  )
})

effectIt.effect(
  "an explicit real playback deadline outlives thirty seconds while control keepalive stays independent",
  () =>
    Effect.gen(function* () {
      const database = yield* Effect.promise(temporaryDatabase)
      yield* Effect.addFinalizer(() => Effect.promise(database.close))
      const transport = voiceTransportFixture()
      yield* Effect.gen(function* () {
        const voice = yield* Voice
        const conversation = yield* Conversation
        const join = yield* voice.start(startVoiceRequest())
        yield* conversation.send(outputInput)
        yield* TestClock.adjust(1)
        const output = (yield* voice.snapshot(join.sessionId, 0)).output
        if (output?.manifest == null) throw new Error("Missing publication")
        yield* voice.ready(join.sessionId, {
          responseId: output.responseId,
          outputEpoch: output.outputEpoch,
          trackSid: output.manifest.trackSid
        })
        yield* TestClock.adjust(20000)
        expect((yield* voice.snapshot(join.sessionId, 0)).status).toBe("active")
        yield* TestClock.adjust(20000)
        const waiting = yield* voice.snapshot(join.sessionId, 0)
        expect(waiting.status).toBe("active")
        expect(waiting.output?.status).toBe("Playing")
        yield* TestClock.adjust(11000)
        const delivered = yield* voice.snapshot(join.sessionId, 0)
        expect(delivered.output?.status).toBe("Delivered")
        expect((yield* conversation.reply(outputInput.deliveryId)).receipt?.outcome).toBe("completed")
        yield* voice.end(join.sessionId)
      }).pipe(
        Effect.provide(
          voiceOutputLayer(
            database.path,
            transport,
            fakeSynthesisLayer({ delayMillis: 50000, sampleFrames: 1200 }),
            undefined,
            undefined,
            undefined,
            { completionMillis: 300000 }
          )
        )
      )
    })
)
