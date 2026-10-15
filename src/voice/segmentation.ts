import type { VoiceFrame } from "./contracts.ts"
const normalizedVoiceThreshold = 0.006
const pcmScale = 32768
const onsetFrames = 3
const silenceFrames = 50
const maximumFrames = 500
const frameBytes = 640
const sampleBytes = 2
// One turn policy for fixed 20 ms PCM frames: 60 ms qualified onset,
// 1000 ms continuous quiet to finish, and a hard 10 s utterance bound.
// Frame RMS admits sustained soft speech without treating an isolated peak as voice.
const voicedFrame = (data: Int16Array) =>
  Math.sqrt(data.reduce((energy, sample) => energy + sample * sample, 0) / data.length) / pcmScale >=
  normalizedVoiceThreshold
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
    const voiced = voicedFrame(frame.data)
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
