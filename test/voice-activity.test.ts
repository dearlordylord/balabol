import { Effect, Fiber } from "effect"
import { expect, it } from "vitest"
import {
  SpeechActivity,
  Voice,
  sileroSpeechActivityLayer,
  type ActivityRuntime,
  type VoiceFrame
} from "../src/voice/index.ts"
import { Segmenter } from "../src/voice/segmentation.ts"
import { Conversation } from "../src/conversation/index.ts"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import { fakeRecognitionLayer } from "../src/speech-recognition/index.ts"
import { startVoiceRequest } from "./voice-admission-fixture.ts"
import { classifiedVoiceInput, withVoiceOutput } from "./voice-output-fixture.ts"
const settings = { modelPath: "fixture-model.onnx" }
const frame = (sample: number): VoiceFrame => ({
  sampleRate: 16000,
  channels: 1,
  samplesPerChannel: 320,
  data: new Int16Array(320).fill(sample)
})
const runtime = (run: (input: Float32Array, state: Float32Array) => Promise<unknown>): ActivityRuntime => ({
  open: () => Effect.succeed({ run })
})

it("retains exact PCM across 320/512 boundaries with private context and recurrent state", async () => {
  const inputs: Float32Array[] = []
  const states: Float32Array[] = []
  const layer = sileroSpeechActivityLayer(
    settings,
    runtime(async (input, state) => {
      inputs.push(input.slice())
      states.push(state.slice())
      return { probability: inputs.length === 1 ? 0.8 : 0.1, state: new Float32Array(256).fill(inputs.length) }
    })
  )
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const activity = yield* SpeechActivity
        const first = yield* activity.open()
        const windows = []
        for (const sample of [1000, 2000, 3000, 4000]) windows.push(...(yield* first.push(frame(sample))))
        expect(windows.map((window) => window.speech)).toEqual([true, false])
        const expected = [
          ...new Int16Array(320).fill(1000),
          ...new Int16Array(320).fill(2000),
          ...new Int16Array(320).fill(3000),
          ...new Int16Array(64).fill(4000)
        ]
        expect(windows.flatMap((window) => [...window.samples])).toEqual(expected)
        expect(inputs[0]?.slice(0, 64)).toEqual(new Float32Array(64))
        expect(inputs[1]?.slice(0, 64)).toEqual(inputs[0]?.slice(-64))
        expect(states[0]).toEqual(new Float32Array(256))
        expect(states[1]).toEqual(new Float32Array(256).fill(1))
        const second = yield* activity.open()
        yield* second.push(frame(5000))
        yield* second.push(frame(6000))
        expect(states[2]).toEqual(new Float32Array(256))
        expect(inputs[2]?.slice(0, 64)).toEqual(new Float32Array(64))
      })
    ).pipe(Effect.provide(layer))
  )
})

it("rejects invalid inference output without falling back to energy and recovers with clean state", async () => {
  let calls = 0
  const layer = sileroSpeechActivityLayer(
    settings,
    runtime(async () => {
      calls += 1
      return { probability: calls === 1 ? Number.NaN : 0.9, state: new Float32Array(256) }
    })
  )
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const stream = yield* (yield* SpeechActivity).open()
        yield* stream.push(frame(1200))
        expect((yield* stream.push(frame(1200)).pipe(Effect.result))._tag).toBe("Failure")
        expect(yield* stream.push(frame(1200))).toEqual([])
        expect((yield* stream.push(frame(1200)))[0]?.speech).toBe(true)
      })
    ).pipe(Effect.provide(layer))
  )
})

it("ignores keyboard-energy windows before onset or admission while genuine classified speech still admits once", async () => {
  const layer = sileroSpeechActivityLayer(
    settings,
    runtime(async (input) => ({
      probability: input.slice(64).some((sample) => sample === 328 / 32768) ? 0.9 : 0.01,
      state: new Float32Array(256)
    }))
  )
  const classified = await Effect.runPromise(classifiedVoiceInput(layer))
  return withVoiceOutput(
    (transport) =>
      Effect.gen(function* () {
        const voice = yield* Voice
        const conversation = yield* Conversation
        const join = yield* voice.start(startVoiceRequest())
        const input = yield* conversation.send({ deliveryId: crypto.randomUUID(), text: "Wait for my speech" })
        for (let index = 0; index < 20; index++) yield* classified.send(transport, transport.audio(2000))
        yield* Effect.sleep(20)
        expect((yield* conversation.reply(input.deliveryId)).state).not.toBe("Interrupted")
        expect(
          (yield* conversation.page({ limit: 100 })).messages.filter((message) => message.role === "user")
        ).toHaveLength(1)
        for (let index = 0; index < 6; index++) yield* classified.send(transport, transport.audio(328))
        for (let index = 0; index < 60; index++) yield* classified.send(transport, transport.audio(0))
        let page = yield* conversation.page({ limit: 100 })
        for (
          let attempt = 0;
          page.messages.filter((message) => message.role === "user").length < 2 && attempt < 200;
          attempt++
        ) {
          yield* Effect.sleep(5)
          page = yield* conversation.page({ limit: 100 })
        }
        expect(page.messages.filter((message) => message.role === "user")).toHaveLength(2)
        expect((yield* conversation.reply(input.deliveryId)).state).toBe("Interrupted")
        yield* voice.end(join.sessionId)
      }),
    fakeSynthesisLayer(),
    fakeAnswerLayer(0),
    fakeRecognitionLayer(),
    undefined,
    undefined,
    classified.layer
  )
})

it("fences an in-flight result and clears recurrent context when microphone continuity resets", async () => {
  let complete: (result: unknown) => void = () => {
    throw new Error("Inference not started")
  }
  let announce: () => void = () => {}
  const started = new Promise<void>((resolve) => {
    announce = resolve
  })
  const pending = new Promise<unknown>((resolve) => {
    complete = resolve
  })
  const states: Float32Array[] = []
  const inputs: Float32Array[] = []
  const layer = sileroSpeechActivityLayer(
    settings,
    runtime(async (input, state) => {
      states.push(state.slice())
      inputs.push(input.slice())
      if (states.length === 1) {
        announce()
        return await pending
      }
      return { probability: 0.9, state: new Float32Array(256) }
    })
  )
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const stream = yield* (yield* SpeechActivity).open()
        yield* stream.push(frame(1200))
        const fiber = yield* stream.push(frame(1200)).pipe(Effect.forkChild)
        yield* Effect.promise(() => started)
        expect((yield* stream.push(frame(1200)).pipe(Effect.result))._tag).toBe("Failure")
        stream.reset()
        complete({ probability: 0.9, state: new Float32Array(256).fill(9) })
        expect(yield* Fiber.join(fiber)).toEqual([])
        expect(yield* stream.push(frame(4000))).toEqual([])
        expect((yield* stream.push(frame(5000)))[0]?.speech).toBe(true)
        expect(states[1]).toEqual(new Float32Array(256))
        expect(inputs[1]?.slice(0, 64)).toEqual(new Float32Array(64))
      })
    ).pipe(Effect.provide(layer))
  )
})

it("preserves every classified source sample across a partial 512-sample ten-second boundary", () => {
  const segmenter = new Segmenter()
  const completed: Uint8Array[] = []
  let onsets = 0
  // Two complete ten-second recognition chunks plus the partially classified-window tail.
  for (let window = 0; window < 625; window++) {
    for (const event of segmenter.push({ samples: new Int16Array(512).fill(window), speech: true })) {
      if (event.speechStarted) onsets += 1
      if (event.bytes !== undefined) completed.push(event.bytes)
    }
  }
  expect(completed.map((bytes) => bytes.length)).toEqual([320000, 320000])
  expect(onsets).toBe(1)
  const combined = Buffer.concat(completed)
  const expected = Buffer.alloc(640000)
  for (let sample = 0; sample < 320000; sample++) expected.writeInt16LE(Math.floor(sample / 512), sample * 2)
  expect(combined).toEqual(expected)
  const endings = []
  for (let window = 0; window < 32; window++)
    endings.push(...segmenter.push({ samples: new Int16Array(512), speech: false }))
  expect(
    endings.map((event) => ({ started: event.speechStarted, ended: event.ended, bytes: event.bytes?.length }))
  ).toEqual([{ started: false, ended: true, bytes: 32000 }])
})

it("fences classification finishing after mute and admits only fresh speech after resume", async () => {
  let complete: (value: unknown) => void = () => {
    throw new Error("No pending inference")
  }
  let signalStarted: () => void = () => {}
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve
  })
  const pending = new Promise<unknown>((resolve) => {
    complete = resolve
  })
  let calls = 0
  const layer = sileroSpeechActivityLayer(
    settings,
    runtime(async (input) => {
      calls += 1
      if (calls === 1) {
        signalStarted()
        return await pending
      }
      return {
        probability: input.slice(64).some((sample) => sample === 328 / 32768) ? 0.9 : 0.01,
        state: new Float32Array(256)
      }
    })
  )
  const classified = await Effect.runPromise(classifiedVoiceInput(layer))
  return withVoiceOutput(
    (transport) =>
      Effect.gen(function* () {
        const voice = yield* Voice
        const conversation = yield* Conversation
        const join = yield* voice.start(startVoiceRequest())
        yield* classified.send(transport, transport.audio(1200))
        yield* transport.send(transport.audio(1200))
        yield* Effect.promise(() => started)
        yield* voice.mute(join.sessionId, true)
        complete({ probability: 0.9, state: new Float32Array(256).fill(9) })
        yield* Effect.sleep(20)
        expect((yield* conversation.page({ limit: 100 })).messages).toEqual([])
        expect((yield* voice.snapshot(join.sessionId, 0)).pending).toEqual([])
        expect(transport.captured).toEqual([])
        yield* voice.mute(join.sessionId, false)
        for (let index = 0; index < 6; index++) yield* classified.send(transport, transport.audio(328))
        for (let index = 0; index < 60; index++) yield* classified.send(transport, transport.audio(0))
        let page = yield* conversation.page({ limit: 100 })
        for (let attempt = 0; page.messages.length === 0 && attempt < 200; attempt++) {
          yield* Effect.sleep(5)
          page = yield* conversation.page({ limit: 100 })
        }
        expect(page.messages.filter((message) => message.role === "user")).toHaveLength(1)
        yield* voice.end(join.sessionId)
      }),
    fakeSynthesisLayer(),
    fakeAnswerLayer(0),
    fakeRecognitionLayer(),
    undefined,
    undefined,
    classified.layer
  )
})
