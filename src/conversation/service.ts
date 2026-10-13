import { Context, Effect, Layer, Semaphore } from "effect"
import { Memory } from "../memory/index.ts"
import type { Message, MessagePage, PageRequest, SendMessage, StorageUnavailable } from "./contracts.ts"
import { DeliveryConflict } from "./contracts.ts"

export {
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
export class Conversation extends Context.Service<
  Conversation,
  {
    send: (message: SendMessage) => Effect.Effect<Message, DeliveryConflict | StorageUnavailable>
    page: (request: PageRequest) => Effect.Effect<MessagePage, StorageUnavailable>
  }
>()("balabol/conversation") {
  static readonly layer = Layer.effect(
    Conversation,
    Effect.gen(function* () {
      const memory = yield* Memory
      const semaphore = yield* Semaphore.make(1)
      const send = Effect.fn("Conversation.send")(
        function* (message: SendMessage) {
          const existing = yield* memory.find(message.deliveryId)
          const payload = existing?.state === "Accepted" ? existing.receipt : existing?.payload
          if (payload !== undefined && payload.text !== message.text)
            return yield* new DeliveryConflict({ message: "Delivery identity already belongs to another payload" })
          if (existing?.state === "Accepted") return existing.receipt
          return yield* memory.append(message)
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
      return Conversation.of({ page, send })
    })
  )
}
