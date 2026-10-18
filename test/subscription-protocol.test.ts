import { it as clockIt } from "@effect/vitest"
import { TestClock } from "effect/testing"
import { OperationAudit, operationAuditLayer } from "../src/operation-audit/index.ts"
import { Deferred, Effect, Fiber } from "effect"
import { expect, it } from "vitest"
import { subscriptionHttpRequest } from "../src/subscription/index.ts"
const requestInit = { method: "GET", headers: {} } satisfies Parameters<ReturnType<typeof subscriptionHttpRequest>>[1]
it("parses bounded successful JSON and excludes untrusted error bodies", async () => {
  for (const status of [200, 401]) {
    const request = subscriptionHttpRequest(() => Promise.resolve(new Response('{"models":[]}', { status })))
    const result = await Effect.runPromise(request("https://api.openai.com/v1/models", requestInit))
    expect(result).toEqual({ status, body: status === 200 ? { models: [] } : null })
  }
})
it("sanitizes invalid, absent and oversized successful response bodies", async () => {
  for (const body of ["fixture-private-invalid-json", null, `"${"x".repeat(1048576)}"`]) {
    const request = subscriptionHttpRequest(() => Promise.resolve(new Response(body, { status: 200 })))
    const result = await Effect.runPromise(Effect.result(request("https://api.openai.com/v1/models", requestInit)))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(JSON.stringify(result.failure)).not.toContain("fixture-private")
  }
})
it("forwards interruption to the HTTP operation rather than continuing abandoned I/O", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      let signal: AbortSignal | null | undefined
      const request = subscriptionHttpRequest((_url, init) => {
        signal = init?.signal
        Effect.runSync(Deferred.succeed(started, undefined))
        return new Promise<Response>((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(new Error("Aborted")), { once: true })
        )
      })
      const fiber = yield* request("https://api.openai.com/v1/models", requestInit).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      expect(signal?.aborted).toBe(true)
    })
  )
})
it("accepts an empty HTTP 200 only when the revocation protocol requests an empty result", async () => {
  const request = subscriptionHttpRequest(() => Promise.resolve(new Response(null, { status: 200 })))
  expect(
    await Effect.runPromise(request("https://auth.openai.com/oauth/revoke", { ...requestInit, responseMode: "empty" }))
  ).toEqual({ status: 200, body: null })
})

clockIt.effect("bounds an uncooperative cancellation and persists its release deadline", () => {
  const lines: string[] = []
  return Effect.gen(function* () {
    const cancelling = yield* Deferred.make<void>()
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        Effect.runSync(Deferred.succeed(cancelling, undefined))
        return new Promise<void>(() => undefined)
      }
    })
    const request = subscriptionHttpRequest(() => Promise.resolve(new Response(body, { status: 401 })))
    const fiber = yield* request("https://api.openai.com/v1/models", requestInit).pipe(Effect.forkChild)
    yield* Deferred.await(cancelling)
    yield* TestClock.adjust(1001)
    expect(yield* Fiber.join(fiber)).toEqual({ status: 401, body: null })
    const audit = yield* OperationAudit
    yield* audit.flush
    expect(lines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        name: "subscription.release",
        outcome: "Failed",
        diagnostic: { category: "Subscription", provider: "subscription", reason: "Deadline" }
      })
    )
  }).pipe(
    Effect.provide(
      operationAuditLayer({
        write: async (line) => {
          lines.push(line)
        }
      })
    )
  )
})
