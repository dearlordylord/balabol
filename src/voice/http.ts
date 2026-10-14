import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import type { VoiceFailed } from "./contracts.ts"
import { Voice } from "./service.ts"
import { VoiceJoin, VoiceSnapshot, MuteRequest, VoiceErrorResponse, failed } from "./contracts.ts"
const unauthorized = 401
const missing = 404
const busy = 409
const invalid = 400
const authorize = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const params = yield* HttpRouter.params
  const voice = yield* Voice
  yield* voice.authorize(params.sessionId ?? "", (request.headers.authorization ?? "").replace(/^Bearer /u, ""))
})
const id = Effect.gen(function* () {
  const params = yield* HttpRouter.params
  return params.sessionId ?? ""
})
const snapshot = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const after = Number(new URL(request.url, "http://localhost").searchParams.get("after") ?? "0")
  if (!Number.isSafeInteger(after) || after < 0) return yield* failed("InvalidCursor", "Invalid event cursor")
  const voice = yield* Voice
  return yield* HttpServerResponse.schemaJson(VoiceSnapshot)(yield* voice.snapshot(yield* id, after))
})
const start = Effect.gen(function* () {
  const voice = yield* Voice
  return yield* HttpServerResponse.schemaJson(VoiceJoin)(yield* voice.start())
})
const mute = Effect.gen(function* () {
  const input = yield* HttpServerRequest.schemaBodyJson(MuteRequest).pipe(
    Effect.mapError(() => failed("InvalidInput", "Invalid mute payload"))
  )
  const voice = yield* Voice
  return yield* HttpServerResponse.schemaJson(VoiceSnapshot)(yield* voice.mute(yield* id, input.muted))
})
const end = Effect.gen(function* () {
  const voice = yield* Voice
  return yield* HttpServerResponse.schemaJson(VoiceSnapshot)(yield* voice.end(yield* id))
})
const errors = Effect.catchTags({
  VoiceFailed: (error: VoiceFailed) =>
    HttpServerResponse.schemaJson(VoiceErrorResponse)(
      { error: { code: error.code, message: error.message } },
      {
        status:
          error.code === "Unauthorized"
            ? unauthorized
            : error.code === "SessionNotFound"
              ? missing
              : error.code === "VoiceBusy"
                ? busy
                : invalid
      }
    )
})
export const voiceRoutes = HttpRouter.use(
  Effect.fn(function* (router) {
    yield* router.add("POST", "/voice/sessions", start.pipe(errors))
    yield* router.add("GET", "/voice/sessions/:sessionId", authorize.pipe(Effect.andThen(snapshot), errors))
    yield* router.add("POST", "/voice/sessions/:sessionId/mute", authorize.pipe(Effect.andThen(mute), errors))
    yield* router.add("POST", "/voice/sessions/:sessionId/end", authorize.pipe(Effect.andThen(end), errors))
  })
)
