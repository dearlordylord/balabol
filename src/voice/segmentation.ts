import type { ActivityWindow } from "./activity.ts"
const onsetSamples = 960
const silenceSamples = 16000
const maximumSamples = 160000
const sampleBytes = 2
/** Classification belongs to SpeechActivity. Timing counts actual PCM samples,
 * including partial classified windows at quiet/max-duration boundaries. */
export class Segmenter {
  #frames: Int16Array[] = []
  #onset: Int16Array[] = []
  #onsetSamples = 0
  #samples = 0
  #quiet = 0
  #active = false
  clear() {
    this.#onset = []
    this.#frames = []
    this.#onsetSamples = 0
    this.#samples = 0
    this.#quiet = 0
    this.#active = false
  }
  #collect(data: Int16Array, speech: boolean) {
    if (this.#active) {
      this.#frames.push(data)
      this.#samples += data.length
      return false
    }
    if (!speech) {
      this.#onset = []
      this.#onsetSamples = 0
      return false
    }
    this.#onset.push(data)
    this.#onsetSamples += data.length
    if (this.#onsetSamples < onsetSamples) return false
    this.#active = true
    this.#frames = this.#onset
    this.#samples = this.#onsetSamples
    this.#onset = []
    this.#onsetSamples = 0
    return true
  }
  #finish(ended: boolean) {
    const bytes = new Uint8Array(this.#samples * sampleBytes)
    const view = new DataView(bytes.buffer)
    let offset = 0
    for (const data of this.#frames)
      for (const sample of data) {
        view.setInt16(offset, sample, true)
        offset += sampleBytes
      }
    const quiet = this.#quiet
    this.clear()
    if (!ended) {
      this.#active = true
      this.#quiet = quiet
    }
    return bytes
  }
  #takeLength(window: ActivityWindow, offset: number): number {
    const available = window.samples.length - offset
    if (!this.#active) return available
    return Math.min(
      available,
      maximumSamples - this.#samples,
      window.speech ? maximumSamples : silenceSamples - this.#quiet
    )
  }
  push(window: ActivityWindow): readonly { speechStarted: boolean; bytes?: Uint8Array; ended?: boolean }[] {
    const events: { speechStarted: boolean; bytes?: Uint8Array; ended?: boolean }[] = []
    let offset = 0
    while (offset < window.samples.length) {
      const length = this.#takeLength(window, offset)
      const data = window.samples.slice(offset, offset + length)
      offset += length
      const speechStarted = this.#collect(data, window.speech)
      if (this.#samples === 0) continue
      this.#quiet = window.speech ? 0 : this.#quiet + data.length
      if (this.#quiet >= silenceSamples || this.#samples >= maximumSamples) {
        const ended = this.#quiet >= silenceSamples
        events.push({ speechStarted, bytes: this.#finish(ended), ended })
      } else if (speechStarted) events.push({ speechStarted })
    }
    return events
  }
}
