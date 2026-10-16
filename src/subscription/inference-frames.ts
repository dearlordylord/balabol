import { inferenceFailed } from "./inference-model.ts"
import { providerFailure } from "./inference-errors.ts"
const maximumBodyBytes = 2097152
const maximumFrameBytes = 65536
const missingBoundary = -1
const separatorCharacters = 2
const dataPrefixCharacters = 5
export class InferenceFrames<Event> {
  constructor(
    private readonly event: (raw: unknown) => readonly Event[],
    private readonly done: () => boolean
  ) {}
  private pending = ""
  private bytes = 0
  private readonly decoder = new TextDecoder("utf-8", { fatal: true })
  push(chunk: Uint8Array): readonly Event[] {
    this.bytes += chunk.byteLength
    if (this.bytes > maximumBodyBytes) throw inferenceFailed("Limit")
    this.pending += this.decoder.decode(chunk, { stream: true })
    this.pending = this.pending.replace(/\r\n/g, "\n")
    const events: Event[] = []
    let boundary = this.pending.indexOf("\n\n")
    while (boundary !== missingBoundary && !this.done()) {
      const frame = this.pending.slice(0, boundary)
      this.pending = this.pending.slice(boundary + separatorCharacters)
      if (Buffer.byteLength(frame) > maximumFrameBytes) throw inferenceFailed("Limit")
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(dataPrefixCharacters).trimStart())
        .join("\n")
      events.push(...this.frame(data))
      boundary = this.pending.indexOf("\n\n")
    }
    if (!this.done() && Buffer.byteLength(this.pending) > maximumFrameBytes) throw inferenceFailed("Limit")
    return events
  }
  private frame(data: string): readonly Event[] {
    return !data || data === "[DONE]" ? [] : this.event(JSON.parse(data))
  }
  finish(): void {
    if (this.done()) return
    if (this.pending.trimStart().startsWith("{")) {
      try {
        throw inferenceFailed(providerFailure(JSON.parse(this.pending), "json"))
      } catch (error) {
        if (error instanceof Error && error.name === "InferenceFailed") throw error
      }
    }
    throw inferenceFailed("Protocol")
  }
}
