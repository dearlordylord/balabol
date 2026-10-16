import { Effect, Stream } from "effect"
import { expect, it } from "vitest"
import { Utterances } from "../src/voice/utterances.ts"
import type { SpeechRecognition } from "../src/speech-recognition/index.ts"

const capabilities: SpeechRecognition["Service"]["capabilities"] = {
  input: "supplied-audio",
  languages: ["en"],
  encoding: "pcm-s16le",
  sampleRateHz: 16000,
  channels: 1,
  maximumSampleFrames: 240000
}
const observations = () => {
  const errors: string[] = []
  const finals: string[] = []
  let started = 0
  return {
    errors,
    finals,
    started: () => started,
    hooks: {
      final: (_id: string, text: string) =>
        Effect.sync(() => {
          finals.push(text)
        }),
      interim: () => Effect.void,
      discarded: () => Effect.void,
      error: (_id: string, error: { message: string }) =>
        Effect.sync(() => {
          errors.push(error.message)
        }),
      started: () => {
        started += 1
      },
      succeeded: () => {}
    }
  }
}
it("queues beyond two requests but fails a five-minute turn atomically rather than committing its prefix", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Effect.scope
        const observed = observations()
        const provider: SpeechRecognition["Service"] = { capabilities, recognize: () => Stream.never }
        const turns = new Utterances(provider, ["en"], scope, observed.hooks)
        expect(turns.start()).toBe(true)
        for (let index = 0; index < 30; index++) yield* turns.push(new Uint8Array(320000), false)
        expect(observed.started()).toBe(2)
        expect(observed.errors).toEqual([])
        yield* turns.push(new Uint8Array(320), false)
        expect(observed.errors).toHaveLength(1)
        expect(observed.finals).toEqual([])
        expect(turns.start()).toBe(false)
        yield* turns.push(new Uint8Array(320), true)
        expect(turns.start()).toBe(true)
        yield* turns.close()
      })
    )
  ))
it("rejects aggregate transcript capacity without admitting individually valid chunk prefixes", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Effect.scope
        const observed = observations()
        const provider: SpeechRecognition["Service"] = {
          capabilities,
          recognize: (request) =>
            Stream.succeed({
              utteranceId: request.utteranceId,
              kind: "Final",
              text: "a".repeat(60000),
              spans: [],
              detectedLanguage: "en"
            })
        }
        const turns = new Utterances(provider, ["en"], scope, observed.hooks)
        turns.start()
        yield* turns.push(new Uint8Array(320000), false)
        yield* turns.push(new Uint8Array(320000), true)
        for (let i = 0; observed.errors.length === 0 && i < 100; i++) yield* Effect.sleep(5)
        expect(observed.errors).toHaveLength(1)
        expect(observed.finals).toEqual([])
        yield* turns.close()
      })
    )
  ))
