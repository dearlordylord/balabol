import { fakeAnswerLayer, AnswerGeneration } from "../answer-generation/index.ts"
import { defaultReplySettings, Replies, ReplyConfiguration } from "./replies.ts"
import { Context, Effect, Layer, Schema, Semaphore } from "effect"
import { ReplyDelivery, DeliverySettlement, ResponseTarget } from "./delivery.ts"
import type { DeliveryTicket, ReplyDeliveryRegistration } from "./delivery.ts"
import { DeliveryId, Memory } from "../memory/index.ts"
import {
  type CurrentTurn,
  ReplyBusy,
  InvalidInput,
  SendMessage,
  DeliveryConflict,
  type Reply,
  type ReplyNotFound,
  type Message,
  type MessagePage,
  PageRequest,
  type StorageUnavailable
} from "./contracts.ts"

export {
  CurrentTurn,
  ReplyNotFound,
  ReplyBusy,
  Reply,
  DeliveryConflict,
  ErrorResponse,
  InvalidInput,
  Message,
  MessagePage,
  PageRequest,
  SendMessage,
  StorageUnavailable,
  WriterUnavailable
} from "./contracts.ts"
const invalidIdentity = () => new InvalidInput({ message: "Invalid conversation identity or input" })
const parseId = (id: string) => Schema.decodeUnknownEffect(DeliveryId)(id).pipe(Effect.mapError(invalidIdentity))
const assertIdentity = (payload: { text: string; role?: "user" | "assistant" } | undefined, message: SendMessage) =>
  payload !== undefined && (payload.text !== message.text || payload.role === "assistant")
    ? Effect.fail(new DeliveryConflict({ message: "Delivery identity already belongs to another payload" }))
    : Effect.void
export class Conversation extends Context.Service<
  Conversation,
  {
    registerReplyDelivery: (
      input: ReplyDeliveryRegistration
    ) => Effect.Effect<{ registrationId: string }, InvalidInput | ReplyBusy>
    deliverySnapshot: (registrationId: string) => Effect.Effect<DeliveryTicket | null, InvalidInput>
    interruptResponse: (target: ResponseTarget) => Effect.Effect<Reply | null, InvalidInput | StorageUnavailable>
    settleReplyDelivery: (ticket: DeliverySettlement) => Effect.Effect<Reply | null, InvalidInput | StorageUnavailable>
    unregisterReplyDelivery: (registrationId: string) => Effect.Effect<void, InvalidInput | StorageUnavailable>
    receipt: (deliveryId: string) => Effect.Effect<Message | null, StorageUnavailable | InvalidInput>
    currentTurn: () => Effect.Effect<CurrentTurn, ReplyNotFound | StorageUnavailable>
    retryReply: (id: string) => Effect.Effect<Reply, ReplyBusy | ReplyNotFound | StorageUnavailable | InvalidInput>
    observeReply: (inputDeliveryId: string) => Effect.Effect<string, ReplyNotFound | StorageUnavailable | InvalidInput>
    releaseReply: (inputDeliveryId: string, token: string) => Effect.Effect<void, InvalidInput>
    reply: (inputDeliveryId: string) => Effect.Effect<Reply, ReplyNotFound | StorageUnavailable | InvalidInput>
    cancelReply: (inputDeliveryId: string) => Effect.Effect<void, InvalidInput>
    send: (
      message: SendMessage
    ) => Effect.Effect<Message, DeliveryConflict | ReplyBusy | StorageUnavailable | InvalidInput>
    page: (request: PageRequest) => Effect.Effect<MessagePage, StorageUnavailable | InvalidInput>
  }
>()("balabol/conversation") {
  static readonly configuredLayer = Layer.effect(
    Conversation,
    Effect.gen(function* () {
      const memory = yield* Memory
      const answer = yield* AnswerGeneration
      const scope = yield* Effect.scope
      const settings = yield* ReplyConfiguration
      const semaphore = yield* Semaphore.make(1)
      const delivery = new ReplyDelivery()
      const deadline = (target: ResponseTarget): Effect.Effect<void, StorageUnavailable> =>
        replies.expire(target).pipe(Effect.asVoid, Effect.uninterruptible, semaphore.withPermits(1))
      const replies = new Replies(memory, answer, scope, settings, delivery, deadline)
      const send = Effect.fn("Conversation.send")(
        function* (raw: SendMessage) {
          const message = yield* Schema.decodeUnknownEffect(SendMessage)(raw).pipe(Effect.mapError(invalidIdentity))
          const existing = yield* memory.find(message.deliveryId)
          const payload = existing?.state === "Accepted" ? existing.receipt : existing?.payload
          yield* assertIdentity(payload, message)
          if (existing?.state === "Accepted") return existing.receipt
          yield* replies.admit()
          const receipt = yield* memory.append({ ...message, role: "user" })
          yield* replies.start(receipt)
          return receipt
        },
        semaphore.withPermits(1),
        Effect.uninterruptible
      )
      const page = Effect.fn("Conversation.page")(function* (raw: PageRequest) {
        const request = yield* Schema.decodeUnknownEffect(PageRequest)(raw).pipe(Effect.mapError(invalidIdentity))
        const messages = yield* memory.page(request.after, request.limit)
        return {
          messages,
          nextAfter: messages.length === request.limit ? (messages[messages.length - 1]?.position ?? null) : null
        }
      })
      const currentTurn = Effect.gen(function* () {
        const input = yield* memory.latestInput()
        return input === undefined ? null : { input, reply: yield* replies.current(input.deliveryId) }
      }).pipe(semaphore.withPermits(1))
      const retryReply = (id: string) =>
        parseId(id).pipe(
          Effect.flatMap((parsed) =>
            Effect.gen(function* () {
              const input = yield* memory.latestInput()
              if (input?.deliveryId !== parsed)
                return yield* new ReplyBusy({ message: "Only the latest accepted input can be retried" })
              const state = yield* replies.current(parsed)
              if (state.state !== "Failed") return state
              return yield* replies.retry(input)
            })
          ),
          semaphore.withPermits(1),
          Effect.uninterruptible
        )
      return Conversation.of({
        registerReplyDelivery: (input) => delivery.register(input).pipe(semaphore.withPermits(1)),
        deliverySnapshot: (id) => parseId(id).pipe(Effect.map((parsed) => delivery.snapshot(parsed))),
        interruptResponse: (target) =>
          Schema.decodeUnknownEffect(ResponseTarget)(target).pipe(
            Effect.mapError(invalidIdentity),
            Effect.flatMap((parsed) => replies.interrupt(parsed)),
            semaphore.withPermits(1),
            Effect.uninterruptible
          ),
        settleReplyDelivery: (ticket) =>
          Schema.decodeUnknownEffect(DeliverySettlement)(ticket).pipe(
            Effect.mapError(invalidIdentity),
            Effect.flatMap((parsed) => replies.settle(parsed)),
            semaphore.withPermits(1),
            Effect.uninterruptible
          ),
        unregisterReplyDelivery: (id) =>
          parseId(id).pipe(
            Effect.flatMap((parsed) =>
              Effect.gen(function* () {
                const active = delivery.snapshot(parsed)
                yield* (active === null ? Effect.void : replies.interrupt(active).pipe(Effect.asVoid)).pipe(
                  Effect.ensuring(Effect.sync(() => delivery.detach(parsed)))
                )
              })
            ),
            semaphore.withPermits(1),
            Effect.uninterruptible
          ),
        receipt: (id) =>
          parseId(id).pipe(
            Effect.flatMap((parsed) => memory.find(parsed)),
            Effect.map((delivery) => (delivery?.state === "Accepted" ? delivery.receipt : null))
          ),
        currentTurn: () => currentTurn,
        retryReply,
        observeReply: (id) => parseId(id).pipe(Effect.flatMap((parsed) => replies.observe(parsed))),
        releaseReply: (id, token) =>
          parseId(id).pipe(
            Effect.flatMap((parsed) => replies.release(parsed, token)),
            semaphore.withPermits(1)
          ),
        page,
        send,
        reply: (id) => parseId(id).pipe(Effect.flatMap((parsed) => replies.current(parsed))),
        cancelReply: (id) =>
          parseId(id).pipe(
            Effect.flatMap((parsed) => replies.cancel(parsed)),
            semaphore.withPermits(1)
          )
      })
    })
  )
  static readonly layer = Conversation.configuredLayer.pipe(
    Layer.provide(Layer.merge(fakeAnswerLayer(), Layer.succeed(ReplyConfiguration, defaultReplySettings)))
  )
}

export { ReplySettings, ReplyConfiguration, defaultReplySettings } from "./replies.ts"
