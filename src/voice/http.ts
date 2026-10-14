import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import type { VoiceFailed } from "./contracts.ts"
import { StartVoiceRequest, ResolveSpeechAdmissions, SpeechResolutions } from "./recovery-contracts.ts"
import { Voice } from "./service.ts"
import {
  VoiceJoin,
  VoiceSnapshot,
  MuteRequest,
  OutputReady,
  OutputInterrupt,
  VoiceErrorResponse,
  failed
} from "./contracts.ts"
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
  return yield* HttpServerResponse.schemaJson(VoiceJoin)(
    yield* voice.start(
      yield* HttpServerRequest.schemaBodyJson(StartVoiceRequest).pipe(
        Effect.mapError(() => failed("InvalidInput", "Invalid voice start payload"))
      )
    )
  )
})
const resolve = Effect.gen(function* () {
  const input = yield* HttpServerRequest.schemaBodyJson(ResolveSpeechAdmissions).pipe(
    Effect.mapError(() => failed("InvalidInput", "Invalid speech recovery identities"))
  )
  const voice = yield* Voice
  return yield* HttpServerResponse.schemaJson(SpeechResolutions)(yield* voice.resolve(input))
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
const ready = Effect.gen(function* () {
  const input = yield* HttpServerRequest.schemaBodyJson(OutputReady).pipe(
    Effect.mapError(() => failed("InvalidInput", "Invalid readiness payload"))
  )
  const voice = yield* Voice
  return yield* HttpServerResponse.schemaJson(VoiceSnapshot)(yield* voice.ready(yield* id, input))
})
const interrupt = Effect.gen(function* () {
  const input = yield* HttpServerRequest.schemaBodyJson(OutputInterrupt).pipe(
    Effect.mapError(() => failed("InvalidInput", "Invalid interruption payload"))
  )
  const voice = yield* Voice
  return yield* HttpServerResponse.schemaJson(VoiceSnapshot)(yield* voice.interrupt(yield* id, input))
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
              : ["VoiceBusy", "StaleOutput", "StartConflict", "StartExpired"].includes(error.code)
                ? busy
                : invalid
      }
    )
})
export const voiceRoutes = HttpRouter.use(
  Effect.fn(function* (router) {
    yield* router.add("POST", "/voice/sessions", start.pipe(errors))
    yield* router.add("POST", "/voice/admissions/resolve", resolve.pipe(errors))
    yield* router.add("GET", "/voice/sessions/:sessionId", authorize.pipe(Effect.andThen(snapshot), errors))
    yield* router.add("POST", "/voice/sessions/:sessionId/mute", authorize.pipe(Effect.andThen(mute), errors))
    yield* router.add("POST", "/voice/sessions/:sessionId/output/ready", authorize.pipe(Effect.andThen(ready), errors))
    yield* router.add(
      "POST",
      "/voice/sessions/:sessionId/output/interrupt",
      authorize.pipe(Effect.andThen(interrupt), errors)
    )
    yield* router.add("POST", "/voice/sessions/:sessionId/end", authorize.pipe(Effect.andThen(end), errors))
  })
)
