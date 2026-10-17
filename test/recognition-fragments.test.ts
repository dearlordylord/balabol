import { Effect } from "effect"
import { expect, it } from "vitest"
import { makeRecognitionFragments } from "../src/voice/recognition-fragments.ts"
it("owns copied PCM and materializes independent little endian slices across fragments", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fragments = makeRecognitionFragments()
      const source = new Int16Array([1, -2, 32767, -32768])
      yield* fragments.put("first", source)
      yield* fragments.put("second", new Int16Array([256, -256]))
      source.fill(0)
      const slices = [
        { fragmentId: "first", offsetSamples: 1, sampleFrames: 2 },
        { fragmentId: "second", offsetSamples: 0, sampleFrames: 2 }
      ]
      const bytes = yield* fragments.materialize(slices)
      expect([...bytes]).toEqual([254, 255, 255, 127, 0, 1, 0, 255])
      bytes.fill(0)
      expect([...(yield* fragments.materialize(slices))]).toEqual([254, 255, 255, 127, 0, 1, 0, 255])
      expect([...(yield* fragments.materialize([{ fragmentId: "first", offsetSamples: 3, sampleFrames: 1 }]))]).toEqual(
        [0, 128]
      )
    })
  )
})
it("rejects duplicate identities and invalid slices, preserving original bytes until explicit release", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fragments = makeRecognitionFragments()
      yield* fragments.put("owned", new Int16Array([42]))
      expect((yield* Effect.flip(fragments.put("owned", new Int16Array([99]))))._tag).toBe("RecognitionFragmentFailed")
      for (const slice of [
        { fragmentId: "missing", offsetSamples: 0, sampleFrames: 1 },
        { fragmentId: "owned", offsetSamples: -1, sampleFrames: 1 },
        { fragmentId: "owned", offsetSamples: 0.5, sampleFrames: 1 },
        { fragmentId: "owned", offsetSamples: 0, sampleFrames: 2 },
        { fragmentId: "owned", offsetSamples: 0, sampleFrames: -1 }
      ])
        expect((yield* Effect.flip(fragments.materialize([slice])))._tag).toBe("RecognitionFragmentFailed")
      expect([...(yield* fragments.materialize([{ fragmentId: "owned", offsetSamples: 0, sampleFrames: 1 }]))]).toEqual(
        [42, 0]
      )
      yield* fragments.release("owned")
      yield* fragments.release("owned")
      expect(
        (yield* Effect.flip(fragments.materialize([{ fragmentId: "owned", offsetSamples: 0, sampleFrames: 1 }])))._tag
      ).toBe("RecognitionFragmentFailed")
      expect([...(yield* fragments.materialize([]))]).toEqual([])
    })
  )
})
