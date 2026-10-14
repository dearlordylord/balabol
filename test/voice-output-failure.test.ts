import { startVoiceRequest } from "./voice-admission-fixture.ts"
import { it as effectIt } from "@effect/vitest"
import { Effect, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import { expect, it } from "vitest"
import { SpeechSynthesis, fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import type { SynthesisEvent, SynthesisRequest } from "../src/speech-synthesis/index.ts"
import { Voice } from "../src/voice/index.ts"
import { Conversation } from "../src/conversation/index.ts"
import { waitForReply } from "./reply-fixture.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { voiceTransportFixture } from "./voice-fixture.ts"
import { voiceOutputLayer, withVoiceOutput, outputInput, waitForOutput } from "./voice-output-fixture.ts"
const badProvider = (events: (request: SynthesisRequest) => SynthesisEvent[]) =>
  Layer.succeed(SpeechSynthesis, {
    capabilities: {
      input: "supplied-text",
      output: "streaming-pcm",
      languages: ["ru", "fr", "en"],
      encoding: "pcm-s16le",
      sampleRateHz: 24000,
      channels: 1,
      maxPhraseChars: 800,
      maxAudioFrames: 240000
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
  it(`interrupts and preserves collected text after ${scenario.name}`, () =>
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
          expect(reply.state).toBe("Interrupted")
          expect(reply.text).toContain("Hello")
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
      expect(reply.text).toContain("Hello")
      expect(transport.captured).toEqual([])
    }).pipe(Effect.provide(voiceOutputLayer(database.path, transport)))
  })
)
it("rejects incompatible language capability before starting a session and releases acquired media", () =>
  withVoiceOutput(
    (transport) =>
      Effect.gen(function* () {
        const voice = yield* Voice
        expect((yield* Effect.flip(voice.start(startVoiceRequest()))).code).toBe("AudioUnavailable")
        expect(transport.closed()).toBe(true)
        expect((yield* Effect.flip(voice.start(startVoiceRequest()))).code).toBe("AudioUnavailable")
      }),
    Layer.succeed(SpeechSynthesis, {
      capabilities: {
        input: "supplied-text",
        output: "streaming-pcm",
        languages: ["ja"],
        encoding: "pcm-s16le",
        sampleRateHz: 24000,
        channels: 1,
        maxPhraseChars: 800,
        maxAudioFrames: 240000
      },
      synthesize: (request) => Stream.fromIterable([completed(request, 0)])
    })
  ))
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
      yield* TestClock.adjust(31000)
      const snapshot = yield* voice.snapshot(join.sessionId, 0)
      expect(snapshot.output?.status).toBe("Failed")
      expect(snapshot.output?.error?.code).toBe("AudioUnavailable")
      const turn = yield* conversation.currentTurn()
      expect(turn?.reply.state).toBe("Interrupted")
      expect(turn?.reply.text).toContain("Hello")
      expect(turn?.reply.receipt?.outcome).toBe("interrupted")
      yield* TestClock.adjust(60000)
      expect(transport.captured).toEqual([])
      expect((yield* conversation.page({ limit: 100 })).messages).toHaveLength(2)
    }).pipe(Effect.provide(voiceOutputLayer(database.path, transport, fakeSynthesisLayer({ delayMillis: 60000 }))))
  })
)
