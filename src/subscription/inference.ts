import { Effect, Layer, Redacted, Schema, Stream } from "effect"
import { Subscription } from "./service.ts"
import { InferenceRequest, InferenceFailed, SubscriptionInference, inferenceFailed } from "./inference-model.ts"
import { ResponseParser } from "./inference-parser.ts"
const cleanupMillis = 1000
const deadlineMillis = 60000
const unauthorized = 401
const forbidden = 403
const tooManyRequests = 429
/** Internal transport port uses platform Response bytes. Credentials remain redacted until the HTTP adapter. */
export type InferenceTransport = (
  request: InferenceRequest,
  token: Redacted.Redacted<string>,
  signal: AbortSignal
) => Promise<Response>
export function inferenceHttpTransport(fetcher: typeof fetch = fetch): InferenceTransport {
  return function requestInference(request, token, signal) {
    return fetcher("https://api.openai.com/v1/responses", {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        Authorization: `Bearer ${Redacted.value(token)}`,
        "content-type": "application/json",
        accept: "text/event-stream"
      },
      body: JSON.stringify({
        model: request.model,
        instructions: request.instructions,
        input: [{ role: "user", content: request.input }],
        store: false,
        stream: true
      })
    })
  }
}
const safeFailure = (error: unknown) => (error instanceof InferenceFailed ? error : inferenceFailed("Protocol"))
function consume(response: Response, controller: AbortController) {
  if (!response.ok) return Stream.fail(inferenceFailed(httpFailure(response.status)))
  const body = response.body
  if (body === null) return Stream.fail(inferenceFailed("Protocol"))
  return Stream.unwrap(
    Effect.gen(function* () {
      const reader = yield* Effect.acquireRelease(
        Effect.sync(() => body.getReader()),
        (reader) =>
          Effect.gen(function* () {
            controller.abort()
            yield* Effect.tryPromise(() => reader.cancel()).pipe(Effect.timeout(cleanupMillis), Effect.ignore)
            yield* Effect.try(() => reader.releaseLock()).pipe(Effect.ignore)
          })
      )
      const parser = new ResponseParser()
      const chunks = Stream.unfold(undefined, () =>
        Effect.tryPromise({ try: () => reader.read(), catch: () => inferenceFailed("Transport") }).pipe(
          Effect.map((next) => (next.done ? undefined : ([next.value, undefined] as const)))
        )
      )
      return chunks.pipe(
        Stream.mapEffect((chunk) => Effect.try({ try: () => parser.push(chunk), catch: safeFailure })),
        Stream.flatMap((events) => Stream.fromIterable(events)),
        Stream.takeUntil((event) => event.kind === "Completed"),
        Stream.concat(
          Stream.unwrap(
            Effect.suspend(() =>
              Effect.try({ try: () => parser.finish(), catch: safeFailure }).pipe(Effect.as(Stream.empty))
            )
          )
        )
      )
    })
  )
}
function httpFailure(status: number): InferenceFailed["reason"] {
  if (status === unauthorized || status === forbidden) return "Authentication"
  return status === tooManyRequests ? "Quota" : "Failed"
}
/** One layer can serve simultaneous answers and independent memory jobs using the same rotating credential owner. */
export const subscriptionInferenceLayer = (transport: InferenceTransport = inferenceHttpTransport()) =>
  Layer.effect(
    SubscriptionInference,
    Effect.gen(function* () {
      const subscription = yield* Subscription
      return SubscriptionInference.of({
        generate: (raw) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const request = yield* Schema.decodeUnknownEffect(InferenceRequest)(raw).pipe(
                Effect.mapError(() => inferenceFailed("Protocol"))
              )
              const controller = yield* Effect.acquireRelease(
                Effect.sync(() => new AbortController()),
                (controller) => Effect.sync(() => controller.abort())
              )
              const work = Stream.unwrap(
                Effect.gen(function* () {
                  const token = yield* subscription
                    .accessToken()
                    .pipe(Effect.mapError(() => inferenceFailed("Authentication")))
                  const response = yield* Effect.tryPromise({
                    try: (signal) => transport(request, token, AbortSignal.any([signal, controller.signal])),
                    catch: () => inferenceFailed("Transport")
                  })
                  if (!response.ok)
                    yield* Effect.promise(() => response.body?.cancel().catch(() => undefined) ?? Promise.resolve())
                  return consume(response, controller)
                })
              )
              return work.pipe(
                Stream.interruptWhen(
                  Effect.sleep(deadlineMillis).pipe(Effect.andThen(Effect.fail(inferenceFailed("Deadline"))))
                )
              )
            })
          )
      })
    })
  )
