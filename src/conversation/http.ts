import { Effect, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { maximumPageSize } from "./contracts.ts"
import type { DeliveryConflict, StorageUnavailable } from "./contracts.ts"
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
const errorResponse = (error: (typeof ErrorResponse.Type)["error"]) =>
  HttpServerResponse.schemaJson(ErrorResponse)(
    { error },
    {
      status:
        error.code === "DeliveryConflict"
          ? conflictStatus
          : error.code === "InvalidInput"
            ? invalidStatus
            : unavailableStatus
    }
  )
const errors = Effect.catchTags({
  InvalidInput: (error: InvalidInput) => errorResponse({ code: error._tag, message: error.message }),
  DeliveryConflict: (error: DeliveryConflict) => errorResponse({ code: error._tag, message: error.message }),
  StorageUnavailable: (error: StorageUnavailable) => errorResponse({ code: error._tag, message: error.message })
})
export const conversationRoutes = HttpRouter.use(
  Effect.fn(function* (router) {
    yield* router.add("POST", "/conversation/messages", send.pipe(errors))
    yield* router.add("GET", "/conversation/messages", page.pipe(errors))
  })
)
