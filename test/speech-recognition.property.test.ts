import { Schema } from "effect"
import fc from "fast-check"
import { expect, test } from "vitest"
import { RecognitionAudio, RecognitionEvent } from "../src/speech-recognition/index.ts"

test("PCM dependent byte count rejects every mismatched frame count", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 240000 }), fc.integer({ min: 1, max: 9 }), (frames, extra) => {
      const audio = {
        encoding: "pcm-s16le",
        sampleRateHz: 16000,
        channels: 1,
        sampleFrames: frames,
        bytes: new Uint8Array(frames * 2)
      }
      expect(Schema.is(RecognitionAudio)(audio)).toBe(true)
      expect(Schema.is(RecognitionAudio)({ ...audio, bytes: new Uint8Array(frames * 2 + extra) })).toBe(false)
    }),
    { numRuns: 50 }
  )
})

test("detected language spans cannot extend beyond final text", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1, maxLength: 100 }), fc.integer({ min: 1, max: 100 }), (text, extra) => {
      expect(
        Schema.is(RecognitionEvent)({
          utteranceId: "11111111-1111-4111-8111-111111111111",
          kind: "Final",
          text,
          spans: [{ language: "fr", start: 0, end: text.length + extra }]
        })
      ).toBe(false)
    })
  )
})
