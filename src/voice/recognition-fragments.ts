import { Effect, Schema } from "effect"
import type { PcmSlice } from "./recognition-state.ts"
const bytesPerSample = 2
export class RecognitionFragmentFailed extends Schema.TaggedError<RecognitionFragmentFailed>()(
  "RecognitionFragmentFailed",
  { message: Schema.String }
) {}
const invalid = (message: string) => new RecognitionFragmentFailed({ message })
const validSlice = (slice: PcmSlice, length: number) =>
  Number.isSafeInteger(slice.offsetSamples) &&
  Number.isSafeInteger(slice.sampleFrames) &&
  slice.offsetSamples >= 0 &&
  slice.sampleFrames >= 0 &&
  slice.offsetSamples + slice.sampleFrames <= length
/** Owns bytes only. The recognition transition decides every release. */
export const makeRecognitionFragments = () => {
  const fragments = new Map<string, Int16Array>()
  const read = (slice: PcmSlice) =>
    Effect.gen(function* () {
      const samples = fragments.get(slice.fragmentId)
      if (samples === undefined) return yield* invalid("Recognition PCM fragment is unavailable")
      if (!validSlice(slice, samples.length)) return yield* invalid("Recognition PCM slice is outside its fragment")
      return samples.subarray(slice.offsetSamples, slice.offsetSamples + slice.sampleFrames)
    })
  return {
    put: (id: string, samples: Int16Array) =>
      Effect.suspend(() => {
        if (fragments.has(id)) return Effect.fail(invalid("Recognition PCM fragment identity is already owned"))
        fragments.set(id, samples.slice())
        return Effect.void
      }),
    materialize: (slices: readonly PcmSlice[]) =>
      Effect.gen(function* () {
        const sources = yield* Effect.forEach(slices, read)
        const bytes = new Uint8Array(sources.reduce((total, source) => total + source.length, 0) * bytesPerSample)
        const view = new DataView(bytes.buffer)
        let offset = 0
        for (const source of sources)
          for (const sample of source) {
            view.setInt16(offset, sample, true)
            offset += bytesPerSample
          }
        return bytes
      }),
    release: (id: string) =>
      Effect.sync(() => {
        fragments.delete(id)
      })
  }
}
