import { withAuditSpan, withAuditStreamSpan } from "../operation-audit/index.ts"
import { Effect, Layer, Redacted, Schema, Stream } from "effect"
import type { Context } from "effect"
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
export const responsesHttpTransport = (
  body: unknown,
  token: Redacted.Redacted<string>,
  signal: AbortSignal,
  fetcher: typeof fetch
) =>
  fetcher("https://api.openai.com/v1/responses", {
    method: "POST",
    redirect: "error",
    signal,
    headers: {
      Authorization: `Bearer ${Redacted.value(token)}`,
      "content-type": "application/json",
      accept: "text/event-stream"
    },
    body: JSON.stringify(body)
  })
export function inferenceHttpTransport(fetcher: typeof fetch = fetch): InferenceTransport {
  return (request, token, signal) =>
    responsesHttpTransport(
      {
        model: request.model,
        instructions: request.instructions,
        input: [{ role: "user", content: request.input }],
        store: false,
        stream: true
      },
      token,
      signal,
      fetcher
    )
}
export const safeFailure = (error: unknown) => (error instanceof InferenceFailed ? error : inferenceFailed("Protocol"))
function consume<Event extends { readonly kind: string }>(
  response: Response,
  controller: AbortController,
  parser: InferenceParser<Event>
) {
  if (!response.ok)
    return Stream.fail(
      new InferenceFailed({
        reason: httpFailure(response.status),
        diagnostic: {
          category: "Subscription",
          reason: httpFailure(response.status),
          provider: "subscription",
          status: response.status
        }
      })
    )
  const body = response.body
  if (body === null) return Stream.fail(inferenceFailed("Protocol"))
  return Stream.unwrap(
    Effect.gen(function* () {
      const reader = yield* Effect.acquireRelease(
        Effect.sync(() => body.getReader()),
        (reader) =>
          Effect.gen(function* () {
            controller.abort()
            yield* Effect.tryPromise({ try: () => reader.cancel(), catch: () => inferenceFailed("Transport") }).pipe(
              Effect.timeout(cleanupMillis),
              Effect.mapError((error) => (error instanceof InferenceFailed ? error : inferenceFailed("Deadline"))),
              withAuditSpan("subscription.release"),
              Effect.ignore
            )
            yield* Effect.try({ try: () => reader.releaseLock(), catch: () => inferenceFailed("Protocol") }).pipe(
              withAuditSpan("subscription.release"),
              Effect.ignore
            )
          })
      )
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
export interface InferenceParser<Event> {
  push(chunk: Uint8Array): readonly Event[]
  finish(): void
}
/** Shared credential acquisition, request cancellation, reader cleanup and total deadline. */
export const inferenceStream = <Request, Event extends { readonly kind: string }>(
  raw: Request,
  schema: Schema.Codec<Request>,
  transport: (request: Request, token: Redacted.Redacted<string>, signal: AbortSignal) => Promise<Response>,
  subscription: Context.Service.Shape<typeof Subscription>,
  makeParser: () => InferenceParser<Event>
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const request = yield* Schema.decodeUnknownEffect(schema)(raw).pipe(
        Effect.mapError(() => inferenceFailed("Protocol"))
      )
      const controller = yield* Effect.acquireRelease(
        Effect.sync(() => new AbortController()),
        (controller) => Effect.sync(() => controller.abort())
      )
      return Stream.unwrap(
        Effect.gen(function* () {
          const token = yield* subscription.accessToken().pipe(
            withAuditSpan("subscription.credentials", undefined, { provider: "subscription" }),
            Effect.mapError(
              (error) =>
                new InferenceFailed({
                  reason: Schema.is(InferenceFailed.fields.reason)(error.kind) ? error.kind : "Failed",
                  diagnostic: { category: "Subscription", reason: error.kind, provider: "subscription" }
                })
            )
          )
          const response = yield* Effect.tryPromise({
            try: (signal) => transport(request, token, AbortSignal.any([signal, controller.signal])),
            catch: () => inferenceFailed("Transport")
          })
          if (!response.ok)
            yield* Effect.tryPromise({
              try: () => response.body?.cancel() ?? Promise.resolve(),
              catch: () => inferenceFailed("Transport")
            }).pipe(withAuditSpan("subscription.release"), Effect.ignore)
          return consume(response, controller, makeParser())
        })
      ).pipe(
        Stream.interruptWhen(
          Effect.sleep(deadlineMillis).pipe(Effect.andThen(Effect.fail(inferenceFailed("Deadline"))))
        ),
        withAuditStreamSpan("subscription.inference", undefined, { provider: "subscription" })
      )
    })
  )
/** One layer can serve simultaneous answers and independent memory jobs using the same rotating credential owner. */
export const subscriptionInferenceLayer = (transport: InferenceTransport = inferenceHttpTransport()) =>
  Layer.effect(
    SubscriptionInference,
    Effect.gen(function* () {
      const subscription = yield* Subscription
      return SubscriptionInference.of({
        generate: (raw) => inferenceStream(raw, InferenceRequest, transport, subscription, () => new ResponseParser())
      })
    })
  )
