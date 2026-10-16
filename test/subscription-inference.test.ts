import { it } from "@effect/vitest"
import { Effect, Fiber, Layer, Redacted, Stream } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vitest"
import {
  Subscription,
  SubscriptionInference,
  subscriptionInferenceLayer,
  inferenceHttpTransport
} from "../src/subscription/index.ts"
import type { InferenceTransport } from "../src/subscription/index.ts"
import { AnswerGeneration } from "../src/answer-generation/index.ts"
import { knowledgeAnswerLayer } from "./knowledge-answer-fixture.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import { sqliteStorageLayer } from "../src/memory/index.ts"
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
const delta = frame({ type: "response.output_text.delta", delta: "bonjour" })
const completed = frame({ type: "response.completed", response: { status: "completed", output: [] } })
const request = { model: "gpt-6.1-sol", instructions: "explicit", input: "synthetic" } as const
const subscription = Layer.succeed(
  Subscription,
  Subscription.of({
    begin: () => Effect.die("unused"),
    complete: () => Effect.die("unused"),
    status: () => Effect.succeed({ kind: "Connected", expiresAt: 999999 }),
    accessToken: () => Effect.succeed(Redacted.make("fixture-token")),
    models: () => Effect.succeed([request.model]),
    disconnect: () => Effect.succeed({ revocation: "NotNeeded" })
  })
)
const layer = (transport: InferenceTransport) => subscriptionInferenceLayer(transport).pipe(Layer.provide(subscription))
const body = (text: string) => new Response(text, { headers: { "content-type": "application/json" } })
const collect = (text: string) =>
  Effect.gen(function* () {
    const inference = yield* SubscriptionInference
    return yield* Stream.runCollect(inference.generate(request))
  }).pipe(Effect.provide(layer(async () => body(text))))
it.effect("accepts schema-valid SSE despite MIME and emits one completion, excluding post-terminal output", () =>
  collect(delta + completed + frame({ type: "response.output_text.delta", delta: "late" })).pipe(
    Effect.map((events) => expect(events).toEqual([{ kind: "Delta", text: "bonjour" }, { kind: "Completed" }]))
  )
)
for (const [name, text, reason] of [
  ["failed", frame({ type: "response.failed" }), "Failed"],
  ["incomplete", frame({ type: "response.incomplete" }), "Incomplete"],
  ["EOF", delta, "Protocol"],
  ["empty", completed, "Protocol"],
  ["invalid delta", frame({ type: "response.output_text.delta", delta: 7 }), "Protocol"],
  ["tool", frame({ type: "response.output_item.added", item: { type: "function_call" } }), "Protocol"],
  ["frame cap", `data: ${"x".repeat(65537)}`, "Limit"],
  [
    "output cap",
    Array.from({ length: 3 }, () => frame({ type: "response.output_text.delta", delta: "x".repeat(40000) })).join(""),
    "Limit"
  ]
])
  it.effect(`rejects ${name} without accepting a completion`, () =>
    collect(text ?? "").pipe(
      Effect.flip,
      Effect.map((error) => expect(error.reason).toBe(reason))
    )
  )
it.effect("classifies auth and quota failures and allows a fresh request without restarting", () =>
  Effect.gen(function* () {
    const inference = yield* SubscriptionInference
    for (const expected of ["Authentication", "Quota"]) {
      const error = yield* Stream.runCollect(inference.generate(request)).pipe(Effect.flip)
      expect(error.reason).toBe(expected)
    }
    expect((yield* Stream.runCollect(inference.generate(request))).at(-1)).toEqual({ kind: "Completed" })
  }).pipe(
    Effect.provide(
      layer(
        (() => {
          const statuses = [401, 429, 200]
          return async () => new Response(delta + completed, { status: statuses.shift() ?? 200 })
        })()
      )
    )
  )
)
it.effect("interrupts a blocked fetch, rejects late output and permits an independent request", () =>
  Effect.gen(function* () {
    let markEntered = () => {}
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    let aborted = false
    const transport: InferenceTransport = async (_request, _token, signal) => {
      if (aborted) return body(delta + completed)
      yieldSignal(signal, () => {
        aborted = true
      })
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
        markEntered()
      })
    }
    yield* Effect.gen(function* () {
      const inference = yield* SubscriptionInference
      const running = yield* Effect.forkChild(Stream.runCollect(inference.generate(request)))
      yield* Effect.promise(() => entered)
      yield* Fiber.interrupt(running).pipe(Effect.timeout("1 second"))
      expect(aborted).toBe(true)
      expect((yield* Stream.runCollect(inference.generate(request))).at(-1)).toEqual({ kind: "Completed" })
    }).pipe(Effect.provide(layer(transport)))
  })
)
function yieldSignal(signal: AbortSignal, action: () => void) {
  signal.addEventListener("abort", action, { once: true })
}
it.effect("enforces a total deadline even while an upstream fetch never resolves", () =>
  Effect.gen(function* () {
    const inference = yield* SubscriptionInference
    const running = yield* Effect.forkChild(Stream.runCollect(inference.generate(request)).pipe(Effect.flip))
    yield* TestClock.adjust(60001)
    expect((yield* Fiber.join(running)).reason).toBe("Deadline")
  }).pipe(Effect.provide(layer(async () => new Promise<Response>(() => undefined))))
)
it("maps explicit memory and requested language to real deltas with truthful empty spans", async () => {
  const database = await temporaryDatabase()
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const answer = yield* AnswerGeneration
          const events = yield* Stream.runCollect(
            answer.generate({
              inputDeliveryId: "11111111-1111-4111-8111-111111111111",
              responseId: "22222222-2222-4222-8222-222222222222",
              model: request.model,
              prior: "PRIOR",
              input: "CURRENT",
              inputLanguageSpans: [],
              responseLanguage: "fr",
              capabilities: ["memory.context"]
            })
          )
          expect(events).toEqual([{ kind: "Delta", text: "bonjour", languageSpans: [] }, { kind: "Completed" }])
        })
      ).pipe(
        Effect.provide(
          knowledgeAnswerLayer(async (input) => {
            expect(JSON.stringify(input.input)).toContain("fr")
            expect(JSON.stringify(input.input)).toContain("PRIOR")
            expect(JSON.stringify(input.input)).toContain("CURRENT")
            return body(delta + completed)
          }).pipe(Layer.provide(sqliteStorageLayer(database.path)))
        )
      )
    )
  } finally {
    await database.close()
  }
})
it.effect("HTTP adapter sends only the allowed fields, fixed endpoint and redacted authorization", () =>
  Effect.tryPromise(async () => {
    const transport = inferenceHttpTransport(async (url, init) => {
      expect(url).toBe("https://api.openai.com/v1/responses")
      expect(init?.redirect).toBe("error")
      expect(init?.headers).toEqual({
        Authorization: "Bearer fixture-token",
        "content-type": "application/json",
        accept: "text/event-stream"
      })
      expect(JSON.parse(typeof init?.body === "string" ? init.body : "null")).toEqual({
        model: request.model,
        instructions: request.instructions,
        input: [{ role: "user", content: request.input }],
        store: false,
        stream: true
      })
      return body(delta + completed)
    })
    await transport(request, Redacted.make("fixture-token"), new AbortController().signal)
  })
)
it.effect("interrupting a blocked body cancels its reader and releases the lock", () =>
  Effect.gen(function* () {
    let entered = () => {}
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    let cancelled = false
    const bytes = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(delta))
      },
      cancel() {
        cancelled = true
      }
    })
    yield* Effect.gen(function* () {
      const inference = yield* SubscriptionInference
      const running = yield* Effect.forkChild(
        inference.generate(request).pipe(
          Stream.tap(() => Effect.sync(entered)),
          Stream.runCollect
        )
      )
      yield* Effect.promise(() => ready)
      yield* Fiber.interrupt(running).pipe(Effect.timeout("1 second"))
      expect(cancelled).toBe(true)
      expect(bytes.locked).toBe(false)
    }).pipe(Effect.provide(layer(async () => new Response(bytes))))
  })
)
it.effect("rejects aggregate byte overflow even with individually valid frames", () =>
  collect(
    Array.from({ length: 40 }, () => frame({ type: "response.queued", ignored: "x".repeat(60000) })).join("")
  ).pipe(
    Effect.flip,
    Effect.map((error) => expect(error.reason).toBe("Limit"))
  )
)
for (const [code, reason] of [
  ["subscription_sharing_usage_limit_exceeded", "Quota"],
  ["chatpass_v2_scope_not_authorized", "Authentication"]
]) {
  it.effect(`classifies HTTP200 failed event ${code} without leaking upstream messages`, () =>
    collect(frame({ type: "response.failed", response: { error: { code, message: "PRIVATE" } } })).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error.reason).toBe(reason)
        expect(JSON.stringify(error)).not.toContain("PRIVATE")
      })
    )
  )
}
it.effect("classifies bounded HTTP200 JSON quota errors without accepting completion", () =>
  collect(JSON.stringify({ error: { code: "insufficient_quota", message: "PRIVATE" } })).pipe(
    Effect.flip,
    Effect.map((error) => expect(error.reason).toBe("Quota"))
  )
)
it.effect("rejects hidden tool output carried only in the completed response", () =>
  collect(
    delta +
      frame({ type: "response.completed", response: { status: "completed", output: [{ type: "function_call" }] } })
  ).pipe(
    Effect.flip,
    Effect.map((error) => expect(error.reason).toBe("Protocol"))
  )
)
it.effect("parses fragmented UTF-8 and CRLF boundaries without inventing language spans", () =>
  Effect.gen(function* () {
    const bytes = new TextEncoder().encode(
      frame({ type: "response.output_text.delta", delta: "日本語" }).replaceAll("\n", "\r\n") + completed
    )
    const transport: InferenceTransport = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
            controller.close()
          }
        })
      )
    yield* Effect.gen(function* () {
      const inference = yield* SubscriptionInference
      expect(yield* Stream.runCollect(inference.generate(request))).toEqual([
        { kind: "Delta", text: "日本語" },
        { kind: "Completed" }
      ])
    }).pipe(Effect.provide(layer(transport)))
  })
)
it.effect("accepts message/reasoning item lifecycle events before a completed text response", () =>
  collect(
    frame({ type: "response.output_item.added", item: { type: "reasoning" } }) +
      delta +
      frame({ type: "response.output_item.done", item: { type: "message" } }) +
      completed
  ).pipe(Effect.map((events) => expect(events.at(-1)).toEqual({ kind: "Completed" })))
)
for (const type of ["response.tool.started", "response.function_call.delta"])
  it.effect(`rejects unsolicited ${type} events`, () =>
    collect(frame({ type })).pipe(
      Effect.flip,
      Effect.map((error) => expect(error.reason).toBe("Protocol"))
    )
  )
it.effect("classifies direct SSE error events without retaining upstream text", () =>
  collect(frame({ type: "error", code: "invalid_token", message: "PRIVATE" })).pipe(
    Effect.flip,
    Effect.map((error) => expect(error.reason).toBe("Authentication"))
  )
)
