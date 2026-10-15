import { Memory as UniiMemory } from "@firfi/unii"
import type { Backend, Storage } from "@firfi/unii"
import { Schema } from "effect"
import { SummaryFailed } from "../summary-generation/index.ts"
import type { DurableMemory } from "./adapter.ts"
import { DeliveryPayload, PriorSnapshot, Receipt, samePayload } from "./contracts.ts"

type CoreState =
  | { kind: "Ready"; core: UniiMemory }
  | { kind: "RecoveryRequired"; core: UniiMemory | null }
  | { kind: "Closed" }

/** A core session closes independently from the host's exclusive durable writer lease. */
const sessionStorage = (storage: Storage): Storage => {
  let opened = false
  return {
    open: async () => {
      if (opened) throw new Error("Core session already opened")
      opened = true
    },
    close: async () => {
      opened = false
    },
    load: () => storage.load(),
    appendRecords: (records) => storage.appendRecords(records),
    appendNode: (node) => storage.appendNode(node),
    checkpoint: (checkpoint) => storage.checkpoint(checkpoint)
  }
}

/** Memory's semaphore serializes append, recovery and close; no two cores share the writer. */
export class CoreHost {
  #state: CoreState
  readonly #adapter: DurableMemory["Service"]
  readonly #now: () => number
  readonly #backend: Backend
  readonly #concurrency: number
  private constructor(
    adapter: DurableMemory["Service"],
    now: () => number,
    core: UniiMemory,
    backend: Backend,
    concurrency: number
  ) {
    this.#adapter = adapter
    this.#now = now
    this.#backend = backend
    this.#concurrency = concurrency
    this.#state = { kind: "Ready", core }
  }
  static async open(
    adapter: DurableMemory["Service"],
    now: () => number,
    backend: Backend,
    concurrency: number
  ): Promise<CoreHost> {
    await adapter.storage.open()
    const core = await UniiMemory.open({
      storage: sessionStorage(adapter.storage),
      now,
      backend,
      shouldRetryBackendError,
      policy: { concurrency }
    })
    return new CoreHost(adapter, now, core, backend, concurrency)
  }
  async #ready(): Promise<UniiMemory> {
    const state = this.#state
    if (state.kind === "Closed") throw new Error("Memory host closed")
    if (state.kind === "Ready") return state.core
    this.#state = { kind: "RecoveryRequired", core: null }
    await state.core?.close()
    const core = await UniiMemory.open({
      storage: sessionStorage(this.#adapter.storage),
      now: this.#now,
      backend: this.#backend,
      shouldRetryBackendError,
      policy: { concurrency: this.#concurrency }
    })
    this.#state = { kind: "Ready", core }
    return core
  }
  #accepted(message: DeliveryPayload): Receipt | undefined {
    const evidence = this.#adapter.find(message.deliveryId)
    if (evidence?.state !== "Accepted") return undefined
    if (!samePayload(evidence.receipt, message)) throw new Error("Conflicting delivery payload")
    return evidence.receipt
  }
  async append(raw: DeliveryPayload): Promise<Receipt> {
    const message = Schema.decodeUnknownSync(DeliveryPayload)(raw)
    const accepted = this.#accepted(message)
    if (accepted !== undefined) return accepted
    const core = await this.#ready()
    try {
      this.#adapter.prepare(message)
      const receipt = await core.append(rawInput(message))
      const evidence = this.#adapter.find(message.deliveryId)
      if (evidence?.state !== "Accepted" || evidence.receipt.recordId !== receipt.firstId)
        throw new Error("Missing durable receipt")
      return Schema.decodeUnknownSync(Receipt)({
        ...evidence.receipt,
        recordId: receipt.firstId,
        position: evidence.receipt.position
      })
    } catch (error) {
      this.#state = { kind: "RecoveryRequired", core }
      throw error
    }
  }
  async snapshot(before: number): Promise<PriorSnapshot> {
    const core = await this.#ready()
    const snapshot = core.snapshot({ before })
    return Schema.decodeUnknownSync(PriorSnapshot)({ state: snapshot.state, text: snapshot.text })
  }
  async retryFailed(): Promise<number> {
    const core = await this.#ready()
    return core.retryFailed()
  }
  async pump(): Promise<void> {
    if (this.#state.kind !== "Ready") return
    const core = this.#state.core
    try {
      core.step()
    } catch (error) {
      this.#state = { kind: "RecoveryRequired", core }
      throw error
    }
  }
  async close(): Promise<void> {
    const state = this.#state
    if (state.kind === "Closed") return
    this.#state = { kind: "Closed" }
    await state.core?.close()
  }
}

const rawInput = (message: DeliveryPayload) => ({
  kind: message.outcome === "interrupted" ? "assistant_interrupted" : (message.role ?? "user"),
  text: message.text
})

const shouldRetryBackendError = (error: unknown) => !(error instanceof SummaryFailed) || error.retryable !== false
