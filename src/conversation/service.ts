import { fakeAnswerLayer, AnswerGeneration, AnswerCapabilities, AnswerFailed } from "../answer-generation/index.ts"
import { makeAdmissions } from "./admission.ts"
import type { AdmissionService } from "./admission-contracts.ts"
import { defaultReplySettings, ReplyConfiguration } from "./reply-configuration.ts"
import { Context, Effect, Layer, Schema, Semaphore } from "effect"
import { DeliverySettlement, ResponseTarget } from "./delivery.ts"
import type {
  DeliveryTicket,
  ReplyDeliveryRegistration,
  ReplyDeliverySubscription,
  ReplyDeliveryAuthorization
} from "./delivery.ts"
import { DeliveryId, Memory } from "../memory/index.ts"
import {
  type SendMessage,
  type DeliveryConflict,
  type CurrentTurn,
  type ReplyBusy,
  InvalidInput,
  type Reply,
  type ReplyNotFound,
  type Message,
  type MessagePage,
  OlderPageRequest,
  type OlderMessagePage,
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
  OlderMessagePage,
  OlderPageRequest,
  PageRequest,
  SendMessage,
  StorageUnavailable,
  WriterUnavailable
} from "./contracts.ts"
const invalidIdentity = () => new InvalidInput({ message: "Invalid conversation identity or input" })
const parseId = (id: string) => Schema.decodeUnknownEffect(DeliveryId)(id).pipe(Effect.mapError(invalidIdentity))
export class Conversation extends Context.Service<
  Conversation,
  AdmissionService & {
    readonly replyLanguages: readonly string[]
    registerReplyDelivery: (
      input: ReplyDeliveryRegistration
    ) => Effect.Effect<ReplyDeliverySubscription, InvalidInput | ReplyBusy>
    replyDeliveryAuthorization: (ticket: DeliveryTicket) => ReplyDeliveryAuthorization
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
    olderPage: (request: OlderPageRequest) => Effect.Effect<OlderMessagePage, StorageUnavailable | InvalidInput>
    page: (request: PageRequest) => Effect.Effect<MessagePage, StorageUnavailable | InvalidInput>
  }
>()("balabol/conversation") {
  static readonly configuredLayer = Layer.effect(
    Conversation,
    Effect.gen(function* () {
      const memory = yield* Memory
      const provider = yield* AnswerGeneration
      const capabilities = yield* Schema.decodeUnknownEffect(AnswerCapabilities)(provider.capabilities).pipe(
        Effect.mapError(() => new AnswerFailed({ message: "Invalid answer provider capabilities" }))
      )
      const answer = { ...provider, capabilities }
      const scope = yield* Effect.scope
      const settings = yield* ReplyConfiguration
      const semaphore = yield* Semaphore.make(1)
      const { admissions, replies } = yield* makeAdmissions(
        memory,
        answer,
        settings,
        scope,
        semaphore,
        answer.capabilities.languages
      )
      const send = Effect.fn("Conversation.send")(function* (message: SendMessage) {
        const reservation = yield* admissions.registerInput({ message })
        return yield* admissions.submitInput(reservation)
      }, Effect.uninterruptible)
      const page = Effect.fn("Conversation.page")(function* (raw: PageRequest) {
        const request = yield* Schema.decodeUnknownEffect(PageRequest)(raw).pipe(Effect.mapError(invalidIdentity))
        const messages = yield* memory.page(request.after, request.limit)
        return {
          messages,
          nextAfter: messages.length === request.limit ? (messages[messages.length - 1]?.position ?? null) : null
        }
      })
      const olderPage = Effect.fn("Conversation.olderPage")(function* (raw: OlderPageRequest) {
        const request = yield* Schema.decodeUnknownEffect(OlderPageRequest)(raw).pipe(Effect.mapError(invalidIdentity))
        const rows = yield* memory.olderPage(request.before, request.limit)
        const messages = rows.slice(0, request.limit).toReversed()
        return { messages, nextBefore: rows.length > request.limit ? (messages[0]?.position ?? null) : null }
      })
      const currentTurn = Effect.gen(function* () {
        const input = yield* memory.latestInput()
        return input === undefined ? null : { input, reply: yield* replies.current(input.deliveryId) }
      })
      const retryReply = (id: string) =>
        parseId(id).pipe(
          Effect.flatMap((parsed) => replies.retry(parsed)),
          Effect.uninterruptible
        )
      return Conversation.of({
        ...admissions,
        replyLanguages: answer.capabilities.languages,
        replyDeliveryAuthorization: replies.authorization,
        registerReplyDelivery: (input) => replies.register(input),
        deliverySnapshot: (id) => parseId(id).pipe(Effect.flatMap((parsed) => replies.snapshot(parsed))),
        interruptResponse: (target) =>
          Schema.decodeUnknownEffect(ResponseTarget)(target).pipe(
            Effect.mapError(invalidIdentity),
            Effect.flatMap((parsed) => replies.interrupt(parsed)),
            Effect.uninterruptible
          ),
        settleReplyDelivery: (ticket) =>
          Schema.decodeUnknownEffect(DeliverySettlement)(ticket).pipe(
            Effect.mapError(invalidIdentity),
            Effect.flatMap((parsed) => replies.settle(parsed)),
            Effect.uninterruptible
          ),
        unregisterReplyDelivery: (id) =>
          parseId(id).pipe(
            Effect.flatMap((parsed) => replies.unregister(parsed)),
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
        releaseReply: (id, token) => parseId(id).pipe(Effect.flatMap((parsed) => replies.release(parsed, token))),
        page,
        olderPage,
        send,
        reply: (id) => parseId(id).pipe(Effect.flatMap((parsed) => replies.current(parsed))),
        cancelReply: (id) => parseId(id).pipe(Effect.flatMap((parsed) => replies.cancel(parsed)))
      })
    })
  )
  static readonly layer = Conversation.configuredLayer.pipe(
    Layer.provide(Layer.merge(fakeAnswerLayer(), Layer.succeed(ReplyConfiguration, defaultReplySettings)))
  )
}

export { ReplySettings, ReplyConfiguration, defaultReplySettings } from "./reply-configuration.ts"
