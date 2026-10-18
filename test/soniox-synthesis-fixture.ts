import { Deferred, Effect } from "effect"
import type { SonioxSynthesisSocketFactory } from "../src/speech-synthesis/index.ts"
/** Deterministic transport port implementing the platform socket contract. */
export class SonioxSynthesisSocket extends EventTarget implements WebSocket {
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = WebSocket.CLOSING
  readonly CLOSED = WebSocket.CLOSED
  binaryType: WebSocket["binaryType"] = "arraybuffer"
  bufferedAmount = 0
  extensions = ""
  protocol = ""
  readyState = 1
  url = "wss://fixture.invalid"
  onopen: WebSocket["onopen"] = null
  onmessage: WebSocket["onmessage"] = null
  onclose: WebSocket["onclose"] = null
  onerror: WebSocket["onerror"] = null
  readonly created = Deferred.makeUnsafe<void>()
  readonly opened = Deferred.makeUnsafe<void>()
  closed = false
  readonly sent: unknown[] = []
  constructor(
    readonly packets: readonly unknown[] | ((streamId: string) => readonly unknown[]) = [],
    readonly terminal: "finished" | "close" | "error" | "wait" | "connecting" = "finished"
  ) {
    super()
  }
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    this.sent.push(data)
    if (typeof data !== "string" || !data.includes('"text_end":true')) return
    const packets = typeof this.packets === "function" ? this.packets(String(JSON.parse(data).stream_id)) : this.packets
    for (const packet of packets) this.message(packet)
    if (this.terminal === "close") this.onclose?.call(this, new CloseEvent("close"))
    if (this.terminal === "error")
      this.onerror?.call(
        this,
        Object.assign(new Event("error"), {
          message: "network",
          filename: "",
          lineno: 0,
          colno: 0,
          error: new Error("fixture network")
        })
      )
  }
  close() {
    this.closed = true
  }
  message(packet: unknown) {
    this.onmessage?.call(
      this,
      new MessageEvent("message", { data: typeof packet === "string" ? packet : JSON.stringify(packet) })
    )
  }
  readonly factory: SonioxSynthesisSocketFactory = () => {
    Deferred.doneUnsafe(this.created, Effect.void)
    if (this.terminal === "connecting") return this
    queueMicrotask(() => {
      this.onopen?.call(this, new Event("open"))
      Deferred.doneUnsafe(this.opened, Effect.void)
    })
    return this
  }
}
