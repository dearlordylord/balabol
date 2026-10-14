import { createHash, randomUUID } from "node:crypto"
import { Context, Effect, Fiber, Schema, Stream, Clock } from "effect"
import type { Scope } from "effect"
import { AnswerEvent, AnswerFailed, type AnswerGeneration } from "../answer-generation/index.ts"
import {
  samePayload,
  type DeliveryPayload,
  type Memory,
  type Receipt,
  type StorageUnavailable
} from "../memory/index.ts"
import type { ReplyDelivery, ResponseTarget, ResponseInvalidation, DeliverySettlement } from "./delivery.ts"
import { Reply, ReplyNotFound } from "./contracts.ts"

const maximumModelNameLength = 200
const maximumReplyLength = 100_000
const completeAnswer = (completed: boolean, text: string) => completed && text.length > 0
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
  #deliveryDeadline: Fiber.Fiber<void, StorageUnavailable> | undefined
  #pendingCompletion: DeliveryPayload | undefined
  #phase: "Generating" | "Delivering" | "Committing" | "Interrupting" | "Cancelling" | "Terminal" = "Terminal"
  #observer: string | undefined
  constructor(
    readonly memory: Memory["Service"],
    readonly answer: AnswerGeneration["Service"],
    readonly scope: Scope.Scope,
    readonly settings: ReplySettings,
    readonly delivery: ReplyDelivery,
    readonly onDeadline: (target: ResponseTarget) => Effect.Effect<void, StorageUnavailable>
  ) {}
  admit(reason: ResponseInvalidation["reason"] = "Interrupted"): Effect.Effect<void, StorageUnavailable> {
    return Effect.gen({ self: this }, function* () {
      const state = this.#state
      const task = this.#task
      if (state !== undefined && this.#phase !== "Terminal" && this.#phase !== "Committing") {
        // Fence provider updates and retain the exact interrupted intent before any storage yield.
        this.#phase = "Interrupting"
        this.delivery.invalidate(state, reason)
        this.#pendingCompletion = {
          deliveryId: state.responseId,
          responseId: state.responseId,
          inputDeliveryId: state.inputDeliveryId,
          role: "assistant",
          outcome: "interrupted",
          text: state.text
        }
        this.#task = undefined
        if (task !== undefined) yield* Fiber.interrupt(task)
      } else if (this.#phase === "Committing" && task !== undefined) {
        yield* Fiber.await(task)
      }
      const pending = yield* this.memory.pendingReply()
      if (pending !== undefined) yield* this.memory.append(pending)
      yield* this.#settleCompletion()
    }).pipe(Effect.tapError((error) => Effect.sync(() => this.#storageFailure(error))))
  }
  #storageFailure(error: StorageUnavailable): void {
    const state = this.#state
    if (state === undefined) return
    this.delivery.invalidate(state, "Failed")
    this.#phase = "Terminal"
    this.#state = Schema.decodeUnknownSync(Reply)({
      ...state,
      sequence: state.sequence + 1,
      state: "Failed",
      error: { code: "StorageUnavailable", message: error.message },
      receipt: null
    })
  }
  #settleCompletion(): Effect.Effect<void, StorageUnavailable> {
    return Effect.gen({ self: this }, function* () {
      const payload = this.#pendingCompletion
      if (payload === undefined) return
      const receipt = yield* this.#appendReply(payload)
      this.#pendingCompletion = undefined
      const state = this.#state
      if (state === undefined) return
      this.#phase = "Terminal"
      this.#state = Schema.decodeUnknownSync(Reply)({
        ...state,
        sequence: state.sequence + 1,
        state: payload.outcome === "interrupted" ? "Interrupted" : "Completed",
        error: null,
        receipt
      })
    }).pipe(Effect.tapError((error) => Effect.sync(() => this.#storageFailure(error))))
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
      const local = this.#local(inputDeliveryId)
      if (local !== undefined && local.state !== "Failed") return local
      const receipt = yield* this.memory.findReply(inputDeliveryId)
      if (receipt !== undefined) return this.#restored(receipt, inputDeliveryId)
      if (local !== undefined) return local
      const input = yield* this.memory.find(inputDeliveryId)
      if (input?.state !== "Accepted" || input.receipt.role === "assistant")
        return yield* new ReplyNotFound({ message: "Unknown accepted input" })
      return {
        responseId: responseIdentity(inputDeliveryId),
        inputDeliveryId,
        sequence: 0,
        state: "Failed",
        text: "",
        error: { code: "Restarted", message: "Reply state was lost at backend restart; retry the accepted input" },
        receipt: null
      }
    })
  }
  #local(inputDeliveryId: string): Reply | undefined {
    return this.#state?.inputDeliveryId === inputDeliveryId ? this.#state : undefined
  }
  #restored(receipt: Receipt, inputDeliveryId: string): Reply {
    return Schema.decodeUnknownSync(Reply)({
      responseId: receipt.deliveryId,
      inputDeliveryId,
      sequence: maximumReplyLength + 1,
      state: receipt.outcome === "interrupted" ? "Interrupted" : "Completed",
      text: receipt.text,
      error: null,
      receipt
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
    if (next.state === "Failed") this.delivery.invalidate(next, "Failed")
    if (next.state === "Completed" || next.state === "Failed") this.#phase = "Terminal"
    this.#state = Schema.decodeUnknownSync(Reply)({ ...next, sequence: previous.sequence + 1 })
  }
  retry(input: Receipt): Effect.Effect<Reply, ReplyNotFound | StorageUnavailable> {
    return Effect.gen({ self: this }, function* () {
      yield* this.admit()
      const existing = yield* this.current(input.deliveryId)
      if (existing.state === "Completed" || existing.state === "Interrupted") return existing
      yield* this.memory.retryFailed()
      yield* this.start(input, true)
      return yield* this.current(input.deliveryId)
    })
  }
  start(input: Receipt, retry = false): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      if (!retry && this.#state?.inputDeliveryId === input.deliveryId) return
      const responseId = retry ? randomUUID() : responseIdentity(input.deliveryId)
      const base = { responseId, inputDeliveryId: input.deliveryId }
      this.#phase = "Generating"
      this.#observer = undefined
      this.#state = { ...base, sequence: 0, state: "Waiting", text: "", error: null, receipt: null }
      if (this.#deliveryDeadline !== undefined) yield* Fiber.interrupt(this.#deliveryDeadline)
      this.#deliveryDeadline = undefined
      const ticket = yield* this.delivery.begin(base)
      if (ticket !== undefined) {
        this.#deliveryDeadline = yield* Effect.sleep(
          Math.max(0, ticket.deadlineAt - (yield* Clock.currentTimeMillis))
        ).pipe(
          Effect.andThen(Effect.suspend(() => (this.delivery.accepts(ticket) ? this.onDeadline(ticket) : Effect.void))),
          Effect.interruptible,
          Effect.forkIn(this.scope)
        )
      }
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
            this.#state?.responseId === responseId && this.#observer === undefined && !this.delivery.matches(base)
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
      if (!completeAnswer(completed, text))
        return yield* new AnswerFailed({ message: "Provider stream lacks nonempty completed answer" })
      if (!this.#canCommit(base.responseId)) return
      if (this.delivery.matches(base)) {
        this.#phase = "Delivering"
        this.#update({ ...base, state: "Delivering", text, error: null, receipt: null })
        return
      }
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
  interrupt(
    target: ResponseTarget,
    reason: ResponseInvalidation["reason"] = "Interrupted"
  ): Effect.Effect<Reply | null, StorageUnavailable> {
    return Effect.gen({ self: this }, function* () {
      const state = this.#state
      if (state?.responseId !== target.responseId || state.inputDeliveryId !== target.inputDeliveryId) return null
      yield* this.admit(reason)
      return this.#state ?? null
    })
  }
  expire(target: ResponseTarget): Effect.Effect<void, StorageUnavailable> {
    return this.interrupt(target, "Deadline").pipe(Effect.asVoid)
  }
  settle(ticket: DeliverySettlement): Effect.Effect<Reply | null, StorageUnavailable> {
    return Effect.gen({ self: this }, function* () {
      if (!this.delivery.accepts(ticket)) return null
      const state = this.#state
      if (ticket.outcome === "Failed") return yield* this.interrupt(ticket, "Failed")
      if (state?.state !== "Delivering") return null
      this.delivery.complete(ticket)
      this.#phase = "Committing"
      this.#pendingCompletion = {
        deliveryId: state.responseId,
        responseId: state.responseId,
        inputDeliveryId: state.inputDeliveryId,
        role: "assistant",
        outcome: "completed",
        text: state.text
      }
      yield* this.#settleCompletion()
      return this.#state ?? null
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
      if (!this.#canCancel(inputDeliveryId) || state === undefined || this.delivery.matches(state)) return
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
