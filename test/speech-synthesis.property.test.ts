import { Schema } from "effect"
import fc from "fast-check"
import { expect, test } from "vitest"
import { SynthesisAudio } from "../src/speech-synthesis/index.ts"

test("every PCM chunk requires exact frame-aligned bytes and compatible metadata", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 1200 }), fc.integer({ min: 1, max: 5 }), (frames, extra) => {
      const audio = {
        encoding: "pcm-s16le",
        sampleRateHz: 24000,
        channels: 1,
        sampleFrames: frames,
        bytes: new Uint8Array(frames * 2)
      }
      expect(Schema.is(SynthesisAudio)(audio)).toBe(true)
      for (const invalid of [
        { ...audio, bytes: new Uint8Array(frames * 2 + extra) },
        { ...audio, encoding: "opus" },
        { ...audio, sampleRateHz: 16000 },
        { ...audio, channels: 2 }
      ]) {
        expect(Schema.is(SynthesisAudio)(invalid)).toBe(false)
      }
    }),
    { numRuns: 50 }
  )
})
