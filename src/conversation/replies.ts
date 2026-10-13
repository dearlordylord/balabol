import { createHash, randomUUID } from "node:crypto"
import { Context, Effect, Fiber, Schema, Stream } from "effect"
import type { Scope } from "effect"
import { AnswerEvent, AnswerFailed, type AnswerGeneration } from "../answer-generation/index.ts"
import {
  samePayload,
  type DeliveryPayload,
  type Memory,
  type Receipt,
  type StorageUnavailable
} from "../memory/index.ts"
import { Reply, ReplyNotFound } from "./contracts.ts"

const maximumModelNameLength = 200
const maximumReplyLength = 100_000
export const ReplySettings = Schema.Struct({
  answerProvider: Schema.Literal("fake"),
  answerModel: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximumModelNameLength)),
  deltaMillis: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 })),
  contextWaitAttempts: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
  contextWaitMillis: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
  attachmentMillis: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60000 }))
})
export type ReplySettings = typeof ReplySettings.Type
export const defaultReplySettings: ReplySettings = {
  answerProvider: "fake",
  answerModel: "sol",
  deltaMillis: 80,
  contextWaitAttempts: 100,
  contextWaitMillis: 20,
  attachmentMillis: 5000
}
export class ReplyConfiguration extends Context.Service<ReplyConfiguration, ReplySettings>()(
  "balabol/conversation/reply-configuration"
) {}

// UUIDv5 gives an accepted input one stable response identity across backend restart.
const responseIdentity = (inputDeliveryId: string) => {
  const namespace = Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex")
  const bytes = createHash("sha1").update(namespace).update(`balabol.response:${inputDeliveryId}`).digest()
  const hex = bytes.toString("hex")
  const versionNibble = "5"
  const variantPosition = 16
  const hexRadix = 16
  const variantMask = 3
  const variantPrefix = 8
  const variantNibble = (
    (Number.parseInt(hex.charAt(variantPosition), hexRadix) & variantMask) |
    variantPrefix
  ).toString(hexRadix)
  const groupOneEnd = 8
  const groupTwoEnd = 12
  const groupThreeStart = 13
  const groupFourStart = 17
  const groupFourEnd = 20
  const uuidHexLength = 32
  return `${hex.slice(0, groupOneEnd)}-${hex.slice(groupOneEnd, groupTwoEnd)}-${versionNibble}${hex.slice(groupThreeStart, variantPosition)}-${variantNibble}${hex.slice(groupFourStart, groupFourEnd)}-${hex.slice(groupFourEnd, uuidHexLength)}`
}
/** Conversation owns responses; observers never launch generation or own Memory. */
export class Replies {
  #state: Reply | undefined
  #task: Fiber.Fiber<void> | undefined
  #pendingCompletion: DeliveryPayload | undefined
  #phase: "Generating" | "Committing" | "Interrupting" | "Cancelling" | "Terminal" = "Terminal"
  #observer: string | undefined
  constructor(
    readonly memory: Memory["Service"],
    readonly answer: AnswerGeneration["Service"],
    readonly scope: Scope.Scope,
    readonly settings: ReplySettings
  ) {}
  admit(): Effect.Effect<void, StorageUnavailable> {
    return Effect.gen({ self: this }, function* () {
      const pending = yield* this.memory.pendingInterrupt()
      if (pending !== undefined) yield* this.memory.append(pending)
      yield* this.#settleCompletion()
      const state = this.#state
      if (state === undefined || this.#phase === "Terminal") return
      if (this.#phase === "Committing") {
        if (this.#task !== undefined) yield* Fiber.await(this.#task)
        yield* this.#settleCompletion()
        return
      }
      this.#phase = "Interrupting"
      const task = this.#task
      this.#task = undefined
      if (task !== undefined) yield* Fiber.interrupt(task)
      const payload = {
        deliveryId: state.responseId,
        responseId: state.responseId,
        inputDeliveryId: state.inputDeliveryId,
        role: "assistant" as const,
        outcome: "interrupted" as const,
        text: state.text
      }
      const receipt = yield* this.#appendReply(payload)
      this.#phase = "Terminal"
      this.#state = Schema.decodeUnknownSync(Reply)({
        ...state,
        sequence: state.sequence + 1,
        state: "Interrupted",
        error: null,
        receipt
      })
    })
  }
  #settleCompletion(): Effect.Effect<void, StorageUnavailable> {
    return Effect.gen({ self: this }, function* () {
      const payload = this.#pendingCompletion
      if (payload === undefined || this.#phase === "Committing") return
      const receipt = yield* this.#appendReply(payload)
      this.#pendingCompletion = undefined
      const state = this.#state
      if (state === undefined) return
      this.#phase = "Terminal"
      this.#state = Schema.decodeUnknownSync(Reply)({
        ...state,
        sequence: state.sequence + 1,
        state: "Completed",
        error: null,
        receipt
      })
    })
  }
  #appendReply(payload: DeliveryPayload) {
    return this.memory
      .append(payload)
      .pipe(
        Effect.catch((error) =>
          this.memory
            .find(payload.deliveryId)
            .pipe(
              Effect.flatMap((found) =>
                found?.state === "Accepted" && samePayload(found.receipt, payload)
                  ? Effect.succeed(found.receipt)
                  : Effect.fail(error)
              )
            )
        )
      )
  }
  current(inputDeliveryId: string): Effect.Effect<Reply, ReplyNotFound | StorageUnavailable> {
    return Effect.gen({ self: this }, function* () {
      if (this.#state?.inputDeliveryId === inputDeliveryId) return this.#state
      const receipt = yield* this.memory.findReply(inputDeliveryId)
      if (receipt !== undefined)
        return Schema.decodeUnknownSync(Reply)({
          responseId: receipt.deliveryId,
          inputDeliveryId,
          sequence: maximumReplyLength + 1,
          state: receipt.outcome === "interrupted" ? "Interrupted" : "Completed",
          text: receipt.text,
          error: null,
          receipt
        })
      const input = yield* this.memory.find(inputDeliveryId)
      if (input?.state !== "Accepted" || input.receipt.role === "assistant")
        return yield* new ReplyNotFound({ message: "Unknown accepted input" })
      return {
        responseId: responseIdentity(inputDeliveryId),
        inputDeliveryId,
        sequence: 0,
        state: "Failed",
        text: "",
        error: { code: "Restarted", message: "Reply state was lost at backend restart; send a new input" },
        receipt: null
      }
    })
  }
  #acceptsUpdate(previous: Reply, next: Omit<Reply, "sequence">): boolean {
    if (this.#phase === "Terminal" || this.#phase === "Interrupting") return false
    if (this.#phase === "Cancelling" && next.state !== "Failed") return false
    return previous.responseId === next.responseId
  }
  #update(next: Omit<Reply, "sequence">): void {
    const previous = this.#state
    if (previous === undefined) return
    if (!this.#acceptsUpdate(previous, next)) return
    if (next.state === "Completed" || next.state === "Failed") this.#phase = "Terminal"
    this.#state = Schema.decodeUnknownSync(Reply)({ ...next, sequence: previous.sequence + 1 })
  }
  start(input: Receipt): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      if (this.#state?.inputDeliveryId === input.deliveryId) return
      const responseId = responseIdentity(input.deliveryId)
      const base = { responseId, inputDeliveryId: input.deliveryId }
      this.#phase = "Generating"
      this.#observer = undefined
      this.#state = { ...base, sequence: 0, state: "Waiting", text: "", error: null, receipt: null }
      const task = this.#generate(input, base).pipe(
        Effect.interruptible,
        Effect.catch((error) =>
          Effect.sync(() => {
            const text = this.#state?.text ?? ""
            this.#update({
              ...base,
              state: "Failed",
              text,
              error: {
                code: error._tag === "StorageUnavailable" ? "StorageUnavailable" : "ProviderFailed",
                message: error.message
              },
              receipt: null
            })
          })
        )
      )
      const fiber = yield* task.pipe(Effect.forkIn(this.scope))
      this.#task = fiber
      yield* Effect.sleep(this.settings.attachmentMillis).pipe(
        Effect.andThen(
          Effect.suspend(() =>
            this.#state?.responseId === responseId && this.#observer === undefined
              ? this.cancel(input.deliveryId)
              : Effect.void
          )
        ),
        Effect.interruptible,
        Effect.forkIn(this.scope)
      )
    })
  }
  #snapshot(input: Receipt) {
    return Effect.gen({ self: this }, function* () {
      let snapshot = yield* this.memory.snapshot(input.recordId)
      for (let attempts = 0; snapshot.state === "pending" && attempts < this.settings.contextWaitAttempts; attempts++) {
        yield* Effect.sleep(this.settings.contextWaitMillis)
        snapshot = yield* this.memory.snapshot(input.recordId)
      }
      return snapshot
    })
  }
  #canCommit(responseId: string): boolean {
    return this.#phase === "Generating" && this.#state?.responseId === responseId
  }
  #generate(input: Receipt, base: { responseId: string; inputDeliveryId: string }) {
    return Effect.gen({ self: this }, function* () {
      const snapshot = yield* this.#snapshot(input)
      if (snapshot.state !== "ready") {
        this.#update({
          ...base,
          state: "Failed",
          text: "",
          error: {
            code: snapshot.state === "failed" ? "MemoryFailed" : "MemoryPending",
            message: "Prior memory is not ready; no answer was generated"
          },
          receipt: null
        })
        return
      }
      let text = ""
      let completed = false
      yield* this.answer
        .generate({
          model: this.settings.answerModel,
          prior: /^[0-9]+\+[0-9]+\|assistant_interrupted:/m.test(snapshot.text)
            ? `[Interrupted assistant output: generated text may not have been heard; no user agreement implied]\n${snapshot.text}`
            : snapshot.text,
          input: input.text,
          capabilities: ["memory.context"]
        })
        .pipe(
          Stream.runForEach((raw) =>
            Effect.gen({ self: this }, function* () {
              const event = yield* Schema.decodeUnknownEffect(AnswerEvent)(raw).pipe(
                Effect.mapError(() => new AnswerFailed({ message: "Invalid provider event" }))
              )
              if (completed) return yield* new AnswerFailed({ message: "Provider emitted after terminal" })
              if (event.kind === "Completed") {
                completed = true
                return
              }
              text += event.text
              if (text.length > maximumReplyLength)
                return yield* new AnswerFailed({ message: "Provider output exceeds bounded text" })
              this.#update({ ...base, state: "Streaming", text, error: null, receipt: null })
            })
          )
        )
      if (!completed || text.length === 0)
        return yield* new AnswerFailed({ message: "Provider stream lacks nonempty completed answer" })
      if (!this.#canCommit(base.responseId)) return
      this.#phase = "Committing"
      this.#pendingCompletion = {
        deliveryId: base.responseId,
        responseId: base.responseId,
        inputDeliveryId: input.deliveryId,
        role: "assistant",
        outcome: "completed",
        text
      }
      yield* Effect.gen({ self: this }, function* () {
        const receipt = yield* this.#appendReply({
          deliveryId: base.responseId,
          role: "assistant",
          outcome: "completed",
          inputDeliveryId: input.deliveryId,
          responseId: base.responseId,
          text
        })
        this.#pendingCompletion = undefined
        this.#update({ ...base, state: "Completed", text, error: null, receipt })
      }).pipe(Effect.uninterruptible)
    })
  }
  observe(inputDeliveryId: string): Effect.Effect<string, ReplyNotFound | StorageUnavailable> {
    return Effect.gen({ self: this }, function* () {
      yield* this.current(inputDeliveryId)
      const token = randomUUID()
      if (this.#state?.inputDeliveryId === inputDeliveryId) this.#observer = token
      return token
    })
  }
  release(inputDeliveryId: string, token: string): Effect.Effect<void> {
    return Effect.suspend(() => (this.#observer === token ? this.cancel(inputDeliveryId) : Effect.void))
  }
  #canCancel(inputDeliveryId: string): boolean {
    return (
      this.#state?.inputDeliveryId === inputDeliveryId && this.#phase !== "Terminal" && this.#phase !== "Interrupting"
    )
  }
  cancel(inputDeliveryId: string): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const state = this.#state
      const task = this.#task
      if (!this.#canCancel(inputDeliveryId) || state === undefined) return
      if (this.#phase === "Committing") {
        if (task !== undefined) yield* Fiber.await(task)
        return
      }
      this.#phase = "Cancelling"
      if (task !== undefined) yield* Fiber.interrupt(task)
      this.#update({
        ...state,
        text: state.text,
        state: "Failed",
        error: { code: "Cancelled", message: "Reply observer disconnected" },
        receipt: null
      })
    })
  }
}
