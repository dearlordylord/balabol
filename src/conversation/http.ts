import { Effect, Schema, Stream } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { maximumPageSize, Reply } from "./contracts.ts"
import type { DeliveryConflict, ReplyBusy, ReplyNotFound, StorageUnavailable } from "./contracts.ts"
import { Conversation, ErrorResponse, InvalidInput, Message, MessagePage, PageRequest, SendMessage } from "./service.ts"

const readPage = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const url = new URL(request.url, "http://localhost")
  const after = url.searchParams.get("after")
  const limit = url.searchParams.get("limit")
  const raw = {
    ...(after === null ? {} : { after: Number(after) }),
    limit: limit === null ? maximumPageSize : Number(limit)
  }
  return yield* Schema.decodeUnknownEffect(PageRequest)(raw).pipe(
    Effect.mapError(() => new InvalidInput({ message: "Invalid page cursor or limit" }))
  )
})
const send = Effect.gen(function* () {
  const input = yield* HttpServerRequest.schemaBodyJson(SendMessage).pipe(
    Effect.mapError(() => new InvalidInput({ message: "Invalid message payload" }))
  )
  const conversation = yield* Conversation
  return yield* HttpServerResponse.schemaJson(Message)(yield* conversation.send(input))
})
const page = Effect.gen(function* () {
  const input = yield* readPage
  const conversation = yield* Conversation
  return yield* HttpServerResponse.schemaJson(MessagePage)(yield* conversation.page(input))
})
const conflictStatus = 409
const invalidStatus = 400
const unavailableStatus = 503
const missingStatus = 404
const observerPollMillis = 20
const errorResponse = (error: (typeof ErrorResponse.Type)["error"]) =>
  HttpServerResponse.schemaJson(ErrorResponse)(
    { error },
    {
      status:
        error.code === "DeliveryConflict" || error.code === "ReplyBusy"
          ? conflictStatus
          : error.code === "InvalidInput"
            ? invalidStatus
            : error.code === "ReplyNotFound"
              ? missingStatus
              : unavailableStatus
    }
  )
const errors = Effect.catchTags({
  InvalidInput: (error: InvalidInput) => errorResponse({ code: error._tag, message: error.message }),
  ReplyNotFound: (error: ReplyNotFound) => errorResponse({ code: error._tag, message: error.message }),
  ReplyBusy: (error: ReplyBusy) => errorResponse({ code: error._tag, message: error.message }),
  DeliveryConflict: (error: DeliveryConflict) => errorResponse({ code: error._tag, message: error.message }),
  StorageUnavailable: (error: StorageUnavailable) => errorResponse({ code: error._tag, message: error.message })
})
const readReplyId = Effect.gen(function* () {
  const params = yield* HttpRouter.params
  return yield* Schema.decodeUnknownEffect(Schema.String.check(Schema.isUUID()))(params.deliveryId).pipe(
    Effect.mapError(() => new InvalidInput({ message: "Invalid input identity" }))
  )
})
const reply = Effect.gen(function* () {
  const id = yield* readReplyId
  const conversation = yield* Conversation
  return yield* HttpServerResponse.schemaJson(Reply)(yield* conversation.reply(id))
})
const cancel = Effect.gen(function* () {
  const id = yield* readReplyId
  const conversation = yield* Conversation
  yield* conversation.cancelReply(id)
  return HttpServerResponse.empty({ status: 204 })
})
const events = Effect.gen(function* () {
  const id = yield* readReplyId
  const conversation = yield* Conversation
  const token = yield* conversation.observeReply(id)
  let sequence: number | undefined
  const stream = Stream.fromEffect(conversation.reply(id).pipe(Effect.tap(() => Effect.sleep(observerPollMillis))))
    .pipe(Stream.forever)
    .pipe(
      Stream.filter((snapshot) => sequence === undefined || snapshot.sequence > sequence),
      Stream.tap((snapshot) =>
        Effect.sync(() => {
          sequence = snapshot.sequence
        })
      ),
      Stream.takeUntil(
        (snapshot) => snapshot.state === "Completed" || snapshot.state === "Interrupted" || snapshot.state === "Failed"
      ),
      Stream.mapEffect((snapshot) => Schema.encodeUnknownEffect(Reply)(snapshot)),
      Stream.map((snapshot) => new TextEncoder().encode(`data: ${JSON.stringify(snapshot)}\n\n`)),
      Stream.ensuring(conversation.releaseReply(id, token))
    )
  return HttpServerResponse.stream(stream, { contentType: "text/event-stream" })
})
export const conversationRoutes = HttpRouter.use(
  Effect.fn(function* (router) {
    yield* router.add("DELETE", "/conversation/replies/:deliveryId", cancel.pipe(errors))
    yield* router.add("GET", "/conversation/replies/:deliveryId", reply.pipe(errors))
    yield* router.add("GET", "/conversation/replies/:deliveryId/events", events.pipe(errors))
    yield* router.add("POST", "/conversation/messages", send.pipe(errors))
    yield* router.add("GET", "/conversation/messages", page.pipe(errors))
  })
)
