import type { VoiceFrame } from "./contracts.ts"
const voiceThreshold = 600
const silenceFrames = 20
const maximumFrames = 500
const frameBytes = 640
const sampleBytes = 2
// Conservative demo energy gate: 20 ms frames, 400 ms quiet end, 10 s maximum.
export class Segmenter {
  #frames: Int16Array[] = []
  #quiet = 0
  clear() {
    this.#frames = []
    this.#quiet = 0
  }
  push(frame: VoiceFrame): Uint8Array | undefined {
    const voiced = frame.data.some((sample) => Math.abs(sample) >= voiceThreshold)
    if (!voiced && this.#frames.length === 0) return undefined
    this.#frames.push(frame.data.slice())
    this.#quiet = voiced ? 0 : this.#quiet + 1
    if (this.#quiet < silenceFrames && this.#frames.length < maximumFrames) return undefined
    const bytes = new Uint8Array(this.#frames.length * frameBytes)
    const view = new DataView(bytes.buffer)
    let offset = 0
    for (const data of this.#frames)
      for (const sample of data) {
        view.setInt16(offset, sample, true)
        offset += sampleBytes
      }
    this.clear()
    return bytes
  }
}
