import { Effect, Layer, Stream } from "effect"
import { expect, it } from "vitest"
import { SpeechSynthesis, fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import { fakeRecognitionLayer } from "../src/speech-recognition/index.ts"
import { AnswerGeneration, fakeAnswerLayer } from "../src/answer-generation/index.ts"
import type { AnswerEvent } from "../src/answer-generation/index.ts"
import { Voice } from "../src/voice/index.ts"
import { Conversation } from "../src/conversation/index.ts"
import { withVoiceOutput, outputInput, waitForOutput } from "./voice-output-fixture.ts"
it("starts no reply PCM before exact publication readiness and settles durable output only after delivery", () =>
  withVoiceOutput((transport) =>
    Effect.gen(function* () {
      const voice = yield* Voice
      const conversation = yield* Conversation
      const join = yield* voice.start()
      yield* conversation.send(outputInput)
      const waiting = yield* waitForOutput(voice, join.sessionId, "AwaitingReady")
      const output = waiting.output
      if (output?.manifest == null) throw new Error("Missing output publication")
      expect(output.manifest.publisherIdentity).toBe(join.backendParticipantIdentity)
      expect(transport.captured).toEqual([])
      expect((yield* conversation.reply(outputInput.deliveryId)).receipt).toBeNull()
      expect(
        (yield* Effect.flip(
          voice.ready(join.sessionId, {
            responseId: output.responseId,
            outputEpoch: output.outputEpoch,
            trackSid: "wrong"
          })
        )).code
      ).toBe("StaleOutput")
      yield* voice.ready(join.sessionId, {
        responseId: output.responseId.toUpperCase(),
        outputEpoch: output.outputEpoch.toUpperCase(),
        trackSid: output.manifest.trackSid
      })
      const delivered = yield* waitForOutput(voice, join.sessionId, "Delivered")
      expect(delivered.output?.status).toBe("Delivered")
      expect(transport.captured.reduce((frames, chunk) => frames + chunk.frames, 0)).toBeGreaterThan(0)
      expect((yield* conversation.reply(outputInput.deliveryId)).state).toBe("Completed")
      expect((yield* conversation.page({ limit: 100 })).messages).toHaveLength(2)
    })
  ))
it("speech onset fences audio before final recognition and empty recognition cannot resume it", () =>
  withVoiceOutput(
    (transport) =>
      Effect.gen(function* () {
        const voice = yield* Voice
        const conversation = yield* Conversation
        const join = yield* voice.start()
        yield* conversation.send(outputInput)
        const waiting = yield* waitForOutput(voice, join.sessionId, "AwaitingReady")
        const output = waiting.output
        if (output?.manifest == null) throw new Error("Missing publication")
        yield* voice.ready(join.sessionId, {
          responseId: output.responseId,
          outputEpoch: output.outputEpoch,
          trackSid: output.manifest.trackSid
        })
        yield* waitForOutput(voice, join.sessionId, "Playing")
        for (let attempt = 0; transport.captured.length === 0 && attempt < 100; attempt++) yield* Effect.sleep(5)
        expect(transport.captured.length).toBeGreaterThan(0)
        yield* transport.send(transport.audio(1200))
        const stopped = yield* waitForOutput(voice, join.sessionId, "Interrupted")
        expect(stopped.output?.status).toBe("Interrupted")
        const count = transport.captured.length
        for (let frame = 0; frame < 20; frame++) yield* transport.send(transport.audio(0))
        yield* Effect.sleep(150)
        expect(transport.captured).toHaveLength(count)
        expect((yield* conversation.reply(outputInput.deliveryId)).state).toBe("Interrupted")
        expect((yield* conversation.page({ limit: 100 })).messages[1]?.outcome).toBe("interrupted")
        yield* voice.ready(join.sessionId, {
          responseId: output.responseId,
          outputEpoch: output.outputEpoch,
          trackSid: output.manifest.trackSid
        })
        expect(transport.captured).toHaveLength(count)
      }),
    fakeSynthesisLayer(),
    fakeAnswerLayer(0),
    fakeRecognitionLayer({
      languages: ["ru", "fr", "en"],
      scripts: [{ events: [{ kind: "Final", text: "", spans: [] }], delayMillis: 0, failure: null }]
    })
  ))
it("keeps an emoji whole at the phrase bound without dropping ordered reply text", () => {
  const text = `${"x".repeat(799)}😀fin.`
  const phrases: string[] = []
  const answer = Layer.succeed(AnswerGeneration, {
    generate: () => Stream.fromIterable<AnswerEvent>([{ kind: "Delta", text }, { kind: "Completed" }])
  })
  const synthesis = Layer.effect(
    SpeechSynthesis,
    Effect.gen(function* () {
      const provider = yield* SpeechSynthesis
      return SpeechSynthesis.of({
        capabilities: provider.capabilities,
        synthesize: (request) => {
          phrases.push(request.text)
          return provider.synthesize(request)
        }
      })
    })
  ).pipe(Layer.provide(fakeSynthesisLayer({ delayMillis: 0 })))
  return withVoiceOutput(
    () =>
      Effect.gen(function* () {
        const voice = yield* Voice
        const conversation = yield* Conversation
        const join = yield* voice.start()
        yield* conversation.send(outputInput)
        const waiting = yield* waitForOutput(voice, join.sessionId, "AwaitingReady")
        const output = waiting.output
        if (output?.manifest == null) throw new Error("Missing publication")
        yield* voice.ready(join.sessionId, {
          responseId: output.responseId,
          outputEpoch: output.outputEpoch,
          trackSid: output.manifest.trackSid
        })
        yield* waitForOutput(voice, join.sessionId, "Delivered")
        expect(phrases).toEqual(["x".repeat(799), "😀fin."])
        expect((yield* conversation.reply(outputInput.deliveryId)).text).toBe(text)
      }),
    synthesis,
    answer
  )
})
it("a text send fences the old epoch and stale controls cannot interrupt the new reply", () =>
  withVoiceOutput((transport) =>
    Effect.gen(function* () {
      const voice = yield* Voice
      const conversation = yield* Conversation
      const join = yield* voice.start()
      yield* conversation.send(outputInput)
      const first = (yield* waitForOutput(voice, join.sessionId, "AwaitingReady")).output
      if (first?.manifest == null) throw new Error("Missing first publication")
      yield* voice.ready(join.sessionId, {
        responseId: first.responseId,
        outputEpoch: first.outputEpoch,
        trackSid: first.manifest.trackSid
      })
      yield* waitForOutput(voice, join.sessionId, "Playing")
      const nextInput = { deliveryId: "22222222-2222-4222-8222-222222222222", text: "Next" }
      yield* conversation.send(nextInput)
      const second = (yield* waitForOutput(voice, join.sessionId, "AwaitingReady")).output
      if (second?.manifest == null) throw new Error("Missing next publication")
      expect(second.outputEpoch).not.toBe(first.outputEpoch)
      expect(second.manifest.trackSid).not.toBe(first.manifest.trackSid)
      const earlier = transport.captured.filter((chunk) => chunk.outputEpoch === first.outputEpoch)
      yield* voice.interrupt(join.sessionId, {
        responseId: first.responseId,
        inputDeliveryId: first.inputDeliveryId,
        outputEpoch: first.outputEpoch
      })
      yield* voice.ready(join.sessionId, {
        responseId: first.responseId,
        outputEpoch: first.outputEpoch,
        trackSid: first.manifest.trackSid
      })
      yield* voice.ready(join.sessionId, {
        responseId: second.responseId,
        outputEpoch: second.outputEpoch,
        trackSid: second.manifest.trackSid
      })
      yield* waitForOutput(voice, join.sessionId, "Delivered")
      expect((yield* conversation.reply(outputInput.deliveryId)).state).toBe("Interrupted")
      expect((yield* conversation.reply(nextInput.deliveryId)).state).toBe("Completed")
      expect(transport.captured.filter((chunk) => chunk.outputEpoch === first.outputEpoch)).toEqual(earlier)
    })
  ))
it("joining voice never attaches audio to a reply that already started", () =>
  withVoiceOutput((transport) =>
    Effect.gen(function* () {
      const voice = yield* Voice
      const conversation = yield* Conversation
      yield* conversation.send(outputInput)
      yield* conversation.observeReply(outputInput.deliveryId)
      const join = yield* voice.start()
      yield* Effect.sleep(100)
      expect((yield* voice.snapshot(join.sessionId, 0)).output).toBeNull()
      expect(transport.captured).toEqual([])
    })
  ))
