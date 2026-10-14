import type { VoiceFrame } from "./contracts.ts"
const voiceThreshold = 600
const onsetFrames = 3
const silenceFrames = 20
const maximumFrames = 500
const frameBytes = 640
const sampleBytes = 2
// Demo energy gate: 60 ms sustained onset, 400 ms quiet end, 10 s maximum.
export class Segmenter {
  #frames: Int16Array[] = []
  #onset: Int16Array[] = []
  #quiet = 0
  clear() {
    this.#onset = []
    this.#frames = []
    this.#quiet = 0
  }
  #collect(frame: VoiceFrame, voiced: boolean) {
    if (this.#frames.length > 0) {
      this.#frames.push(frame.data.slice())
      return false
    }
    if (!voiced) {
      this.#onset = []
      return false
    }
    this.#onset.push(frame.data.slice())
    if (this.#onset.length < onsetFrames) return false
    this.#frames = this.#onset
    this.#onset = []
    return true
  }
  push(frame: VoiceFrame): { speechStarted: boolean; bytes?: Uint8Array } {
    const voiced = frame.data.some((sample) => Math.abs(sample) >= voiceThreshold)
    const speechStarted = this.#collect(frame, voiced)
    if (this.#frames.length === 0) return { speechStarted }
    this.#quiet = voiced ? 0 : this.#quiet + 1
    if (this.#quiet < silenceFrames && this.#frames.length < maximumFrames) return { speechStarted }
    const bytes = new Uint8Array(this.#frames.length * frameBytes)
    const view = new DataView(bytes.buffer)
    let offset = 0
    for (const data of this.#frames)
      for (const sample of data) {
        view.setInt16(offset, sample, true)
        offset += sampleBytes
      }
    this.clear()
    return { speechStarted, bytes }
  }
}
