import { waitForPriorMemory } from "./prior-context.ts"
import { randomUUID } from "node:crypto"
import { Effect, Fiber, Schema, Stream, Clock } from "effect"
import type { Scope } from "effect"
import { LanguageSpans, validLanguageSpans, type LanguageSpan } from "../language/index.ts"
import { AnswerFailed, type AnswerGeneration } from "../answer-generation/index.ts"
import {
  samePayload,
  type DeliveryPayload,
  type Memory,
  type Receipt,
  type StorageUnavailable
} from "../memory/index.ts"
import type { ReplyDelivery, ResponseTarget, ResponseInvalidation, DeliverySettlement } from "./delivery.ts"
import { parseAnswerEvent, validateAnswerLanguages } from "./answer-languages.ts"
import { selectResponseLanguage } from "./response-language.ts"
import { responseIdentity } from "./response-identity.ts"
import type { ReplySettings } from "./reply-configuration.ts"
import { Reply, ReplyNotFound } from "./contracts.ts"

const maximumReplyLength = 100_000
const languageField = (language: string | null | undefined) => (language == null ? {} : { responseLanguage: language })
const replySpans = (reply: Reply) => reply.languageSpans ?? []
const completeAnswer = (completed: boolean, text: string) => completed && text.length > 0
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
          ...languageField(state.responseLanguage),
          languageSpans: replySpans(state),
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
        ...languageField(input.receipt.responseLanguage),
        responseId: responseIdentity(inputDeliveryId),
        inputDeliveryId,
        sequence: 0,
        state: "Failed",
        languageSpans: [],
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
      ...languageField(receipt.responseLanguage),
      responseId: receipt.deliveryId,
      inputDeliveryId,
      sequence: maximumReplyLength + 1,
      state: receipt.outcome === "interrupted" ? "Interrupted" : "Completed",
      text: receipt.text,
      languageSpans: receipt.languageSpans,
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
  // Conversation serializes new input admission and returns duplicates before starting a reply.
  start(input: Receipt, retry = false): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const responseId = retry ? randomUUID() : responseIdentity(input.deliveryId)
      const base = {
        responseId,
        inputDeliveryId: input.deliveryId,
        responseLanguage:
          input.responseLanguage ??
          selectResponseLanguage(input.languageSpans, input.detectedLanguage, this.answer.capabilities.languages)
      }
      this.#phase = "Generating"
      this.#observer = undefined
      this.#state = { ...base, sequence: 0, state: "Waiting", languageSpans: [], text: "", error: null, receipt: null }
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
              languageSpans: this.#state?.languageSpans ?? [],
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
  #canCommit(responseId: string): boolean {
    return this.#phase === "Generating" && this.#state?.responseId === responseId
  }
  #generate(input: Receipt, base: { responseId: string; inputDeliveryId: string; responseLanguage: string }) {
    return Effect.gen({ self: this }, function* () {
      const snapshot = yield* waitForPriorMemory(this.memory, input.recordId, this.settings)
      if (snapshot.state !== "ready") {
        this.#update({
          ...base,
          state: "Failed",
          languageSpans: [],
          text: "",
          error: {
            code: snapshot.state === "failed" ? "MemoryFailed" : "MemoryPending",
            message: "Prior memory is not ready; no answer was generated"
          },
          receipt: null
        })
        return
      }
      yield* validateAnswerLanguages(this.answer.capabilities, base.responseLanguage, input.languageSpans)
      let text = ""
      let languageSpans: readonly LanguageSpan[] = []
      let completed = false
      yield* this.answer
        .generate({
          model: this.settings.answerModel,
          prior: /^[0-9]+\+[0-9]+\|assistant_interrupted:/m.test(snapshot.text)
            ? `[Interrupted assistant output: generated text may not have been heard; no user agreement implied]\n${snapshot.text}`
            : snapshot.text,
          input: input.text,
          inputLanguageSpans: input.languageSpans,
          responseLanguage: base.responseLanguage,
          capabilities: ["memory.context"]
        })
        .pipe(
          Stream.runForEach((raw) =>
            Effect.gen({ self: this }, function* () {
              const event = yield* parseAnswerEvent(raw, this.answer.capabilities)
              if (completed) return yield* new AnswerFailed({ message: "Provider emitted after terminal" })
              if (event.kind === "Completed") {
                completed = true
                return
              }
              languageSpans = [
                ...languageSpans,
                ...event.languageSpans.map((span) => ({
                  ...span,
                  start: span.start + text.length,
                  end: span.end + text.length
                }))
              ]
              text += event.text
              if (text.length > maximumReplyLength)
                return yield* new AnswerFailed({ message: "Provider output exceeds bounded text" })
              languageSpans = yield* Schema.decodeUnknownEffect(LanguageSpans)(languageSpans).pipe(
                Effect.mapError(() => new AnswerFailed({ message: "Provider annotations exceed bounded spans" }))
              )
              if (!validLanguageSpans(text, languageSpans))
                return yield* new AnswerFailed({ message: "Provider annotations split a Unicode scalar" })
              this.#update({ ...base, state: "Streaming", text, languageSpans, error: null, receipt: null })
            })
          )
        )
      if (!completeAnswer(completed, text))
        return yield* new AnswerFailed({ message: "Provider stream lacks nonempty completed answer" })
      if (!this.#canCommit(base.responseId)) return
      if (this.delivery.matches(base)) {
        this.#phase = "Delivering"
        this.#update({ ...base, state: "Delivering", text, languageSpans, error: null, receipt: null })
        return
      }
      this.#phase = "Committing"
      this.#pendingCompletion = {
        deliveryId: base.responseId,
        responseId: base.responseId,
        inputDeliveryId: input.deliveryId,
        role: "assistant",
        outcome: "completed",
        text,
        responseLanguage: base.responseLanguage,
        languageSpans
      }
      yield* Effect.gen({ self: this }, function* () {
        const receipt = yield* this.#appendReply({
          deliveryId: base.responseId,
          role: "assistant",
          outcome: "completed",
          inputDeliveryId: input.deliveryId,
          responseId: base.responseId,
          text,
          responseLanguage: base.responseLanguage,
          languageSpans
        })
        this.#pendingCompletion = undefined
        this.#update({ ...base, state: "Completed", text, languageSpans, error: null, receipt })
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
        ...languageField(state.responseLanguage),
        languageSpans: replySpans(state),
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
        languageSpans: replySpans(state),
        text: state.text,
        state: "Failed",
        error: { code: "Cancelled", message: "Reply observer disconnected" },
        receipt: null
      })
    })
  }
}
