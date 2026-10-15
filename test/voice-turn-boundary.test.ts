import { Effect, Layer, Stream } from "effect"
import { expect, it } from "vitest"
import { AnswerGeneration, fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { Conversation } from "../src/conversation/index.ts"
import { SpeechRecognition, fakeRecognitionLayer } from "../src/speech-recognition/index.ts"
import { SpeechSynthesis, fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import { Voice } from "../src/voice/index.ts"
import { startVoiceRequest } from "./voice-admission-fixture.ts"
import { withVoiceOutput, waitForOutput } from "./voice-output-fixture.ts"

const fullInput = "Запомни мой тестовый код сорок два"
const waitingAnswer = Layer.succeed(AnswerGeneration, {
  capabilities: { languages: ["ru", "fr", "en"], output: "text-deltas" },
  generate: () => Stream.never
})
const recordingRecognition = (sampleFrames: number[]) =>
  Layer.effect(
    SpeechRecognition,
    Effect.gen(function* () {
      const provider = yield* SpeechRecognition
      return SpeechRecognition.of({
        ...provider,
        recognize: (request) => {
          sampleFrames.push(request.audio.sampleFrames)
          return provider.recognize(request)
        }
      })
    })
  ).pipe(
    Layer.provide(
      fakeRecognitionLayer({
        languages: ["ru", "fr", "en"],
        scripts: [
          {
            events: [{ kind: "Final", text: fullInput, spans: [], detectedLanguage: "ru" }],
            delayMillis: 0,
            failure: null
          }
        ]
      })
    )
  )

const acceptedPage = (conversation: Conversation["Service"]) =>
  Effect.gen(function* () {
    let page = yield* conversation.page({ limit: 100 })
    for (let attempt = 0; page.messages.length === 0 && attempt < 200; attempt++) {
      yield* Effect.sleep(5)
      page = yield* conversation.page({ limit: 100 })
    }
    return page
  })

// Public-Voice regressions use supplied synthetic PCM and deterministic providers;
// no microphone, real inference, synthesis output or private utterance is used.
it("keeps an 800ms natural pause inside one utterance and admits its complete input exactly once", () => {
  const recognizedFrames: number[] = []
  return withVoiceOutput(
    (transport) =>
      Effect.gen(function* () {
        const voice = yield* Voice
        const conversation = yield* Conversation
        const join = yield* voice.start(startVoiceRequest())
        for (let frame = 0; frame < 30; frame++) yield* transport.send(transport.audio(1200))
        for (let frame = 0; frame < 20; frame++) yield* transport.send(transport.audio(0))
        expect(recognizedFrames).toEqual([])
        expect((yield* conversation.page({ limit: 100 })).messages).toEqual([])
        for (let frame = 0; frame < 20; frame++) yield* transport.send(transport.audio(0))
        expect(recognizedFrames).toEqual([])
        for (let frame = 0; frame < 20; frame++) yield* transport.send(transport.audio(1200))
        for (let frame = 0; frame < 49; frame++) yield* transport.send(transport.audio(0))
        expect(recognizedFrames).toEqual([])
        yield* transport.send(transport.audio(0))
        const page = yield* acceptedPage(conversation)
        expect(page.messages.map((message) => message.text)).toEqual([fullInput])
        expect(recognizedFrames).toHaveLength(1)
        expect(recognizedFrames).toEqual([140 * 320])
        expect((yield* conversation.currentTurn())?.reply.state).toBe("Waiting")
        expect(transport.captured).toEqual([])
        yield* voice.end(join.sessionId)
      }),
    fakeSynthesisLayer(),
    waitingAnswer,
    recordingRecognition(recognizedFrames)
  )
})

it("ignores low-RMS sparse breath peaks while a reply waits but interrupts on sustained speech", () =>
  withVoiceOutput(
    (transport) =>
      Effect.gen(function* () {
        const voice = yield* Voice
        const conversation = yield* Conversation
        const join = yield* voice.start(startVoiceRequest())
        const input = yield* conversation.send({
          deliveryId: crypto.randomUUID(),
          text: fullInput,
          detectedLanguage: "ru"
        })
        expect((yield* conversation.reply(input.deliveryId)).state).toBe("Waiting")
        const breath = transport.audio(0)
        breath.data[160] = 750
        const rms = Math.sqrt(breath.data.reduce((total, sample) => total + sample * sample, 0) / breath.data.length)
        expect(rms).toBeLessThan(50)
        for (let frame = 0; frame < 3; frame++) yield* transport.send(breath)
        // Speech interruption runs in an owned fiber; observe its settled result,
        // rather than accepting one transient Waiting snapshot before cancellation.
        for (let observation = 0; observation < 10; observation++) {
          yield* Effect.sleep(5)
          expect((yield* conversation.reply(input.deliveryId)).state).toBe("Waiting")
        }
        expect((yield* conversation.page({ limit: 100 })).messages).toHaveLength(1)
        for (let frame = 0; frame < 10; frame++) yield* transport.send(transport.audio(328))
        let reply = yield* conversation.reply(input.deliveryId)
        for (let attempt = 0; reply.state !== "Interrupted" && attempt < 200; attempt++) {
          yield* Effect.sleep(5)
          reply = yield* conversation.reply(input.deliveryId)
        }
        expect(reply.state).toBe("Interrupted")
        expect(reply.text).toBe("")
        expect(reply.receipt?.outcome).toBe("interrupted")
        expect(transport.captured).toEqual([])
        yield* voice.end(join.sessionId)
      }),
    fakeSynthesisLayer(),
    waitingAnswer
  ))

it("retains the ten-second maximum utterance bound for continuous speech", () => {
  const recognizedFrames: number[] = []
  return withVoiceOutput(
    (transport) =>
      Effect.gen(function* () {
        const voice = yield* Voice
        const conversation = yield* Conversation
        const join = yield* voice.start(startVoiceRequest())
        for (let frame = 0; frame < 499; frame++) yield* transport.send(transport.audio(1200))
        expect(recognizedFrames).toEqual([])
        yield* transport.send(transport.audio(1200))
        for (let attempt = 0; recognizedFrames.length === 0 && attempt < 200; attempt++) yield* Effect.sleep(5)
        expect(recognizedFrames).toEqual([160000])
        expect((yield* acceptedPage(conversation)).messages.map((message) => message.text)).toEqual([fullInput])
        yield* voice.end(join.sessionId)
      }),
    fakeSynthesisLayer(),
    waitingAnswer,
    recordingRecognition(recognizedFrames)
  )
})

it("keeps playing audio through sparse clicks and fences it on genuine new speech", () => {
  const synthesis = Layer.effect(
    SpeechSynthesis,
    Effect.gen(function* () {
      const provider = yield* SpeechSynthesis
      return SpeechSynthesis.of({
        ...provider,
        synthesize: (request) => Stream.concat(provider.synthesize(request).pipe(Stream.take(1)), Stream.never)
      })
    })
  ).pipe(Layer.provide(fakeSynthesisLayer({ delayMillis: 0 })))
  return withVoiceOutput(
    (transport) =>
      Effect.gen(function* () {
        const voice = yield* Voice
        const conversation = yield* Conversation
        const join = yield* voice.start(startVoiceRequest())
        const input = yield* conversation.send({ deliveryId: crypto.randomUUID(), text: "A reply" })
        const output = (yield* waitForOutput(voice, join.sessionId, "AwaitingReady")).output
        if (output?.manifest == null) throw new Error("Missing reply publication")
        yield* voice.ready(join.sessionId, {
          responseId: output.responseId,
          outputEpoch: output.outputEpoch,
          trackSid: output.manifest.trackSid
        })
        for (let attempt = 0; transport.captured.length === 0 && attempt < 200; attempt++) yield* Effect.sleep(5)
        expect(transport.captured).toHaveLength(1)
        const click = transport.audio(0)
        click.data[160] = 750
        for (let frame = 0; frame < 3; frame++) yield* transport.send(click)
        for (let observation = 0; observation < 10; observation++) {
          yield* Effect.sleep(5)
          expect((yield* voice.snapshot(join.sessionId, 0)).output?.status).toBe("Playing")
        }
        for (let frame = 0; frame < 3; frame++) yield* transport.send(transport.audio(328))
        const interrupted = yield* waitForOutput(voice, join.sessionId, "Interrupted")
        expect(interrupted.output?.status).toBe("Interrupted")
        expect(transport.publications[0]?.invalidated).toBe(true)
        expect((yield* conversation.reply(input.deliveryId)).receipt?.outcome).toBe("interrupted")
        yield* voice.end(join.sessionId)
      }),
    synthesis,
    fakeAnswerLayer(0)
  )
})
