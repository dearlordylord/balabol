import { fakeAnswerLayer, AnswerGeneration } from "../answer-generation/index.ts"
import { defaultReplySettings, Replies, ReplyConfiguration } from "./replies.ts"
import { Context, Effect, Layer, Semaphore } from "effect"
import { Memory } from "../memory/index.ts"
import {
  DeliveryConflict,
  type Reply,
  type ReplyBusy,
  type ReplyNotFound,
  type Message,
  type MessagePage,
  type PageRequest,
  type SendMessage,
  type StorageUnavailable
} from "./contracts.ts"

export {
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
const assertIdentity = (payload: { text: string; role?: "user" | "assistant" } | undefined, message: SendMessage) =>
  payload !== undefined && (payload.text !== message.text || payload.role === "assistant")
    ? Effect.fail(new DeliveryConflict({ message: "Delivery identity already belongs to another payload" }))
    : Effect.void
export class Conversation extends Context.Service<
  Conversation,
  {
    observeReply: (inputDeliveryId: string) => Effect.Effect<string, ReplyNotFound | StorageUnavailable>
    releaseReply: (inputDeliveryId: string, token: string) => Effect.Effect<void>
    reply: (inputDeliveryId: string) => Effect.Effect<Reply, ReplyNotFound | StorageUnavailable>
    cancelReply: (inputDeliveryId: string) => Effect.Effect<void>
    send: (message: SendMessage) => Effect.Effect<Message, DeliveryConflict | ReplyBusy | StorageUnavailable>
    page: (request: PageRequest) => Effect.Effect<MessagePage, StorageUnavailable>
  }
>()("balabol/conversation") {
  static readonly configuredLayer = Layer.effect(
    Conversation,
    Effect.gen(function* () {
      const memory = yield* Memory
      const answer = yield* AnswerGeneration
      const scope = yield* Effect.scope
      const settings = yield* ReplyConfiguration
      const replies = new Replies(memory, answer, scope, settings)
      const semaphore = yield* Semaphore.make(1)
      const send = Effect.fn("Conversation.send")(
        function* (message: SendMessage) {
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
      const page = Effect.fn("Conversation.page")(function* (request: PageRequest) {
        const messages = yield* memory.page(request.after, request.limit)
        return {
          messages,
          nextAfter: messages.length === request.limit ? (messages[messages.length - 1]?.position ?? null) : null
        }
      })
      return Conversation.of({
        observeReply: (id) => replies.observe(id),
        releaseReply: (id, token) => replies.release(id, token),
        page,
        send,
        reply: (id) => replies.current(id),
        cancelReply: (id) => replies.cancel(id)
      })
    })
  )
  static readonly layer = Conversation.configuredLayer.pipe(
    Layer.provide(Layer.merge(fakeAnswerLayer(), Layer.succeed(ReplyConfiguration, defaultReplySettings)))
  )
}

export { ReplySettings, ReplyConfiguration, defaultReplySettings } from "./replies.ts"
