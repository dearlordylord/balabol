import { randomUUID } from "node:crypto"
import { Effect, Exit, Fiber, Layer, Redacted, Stream } from "effect"
import { expect, it } from "vitest"
import { reportedTokens, sqliteUsageLayer, UsageLedger, trackInferenceUsage, sonioxUsage } from "../src/usage/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
import {
  Subscription,
  SubscriptionFailed,
  SubscriptionInference,
  subscriptionInferenceLayer,
  SubscriptionToolInference,
  subscriptionToolInferenceLayer
} from "../src/subscription/index.ts"

const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
const subscription = Layer.succeed(
  Subscription,
  Subscription.of({
    begin: () => Effect.die("unused"),
    complete: () => Effect.die("unused"),
    status: () => Effect.succeed({ kind: "Connected", expiresAt: 999999 }),
    accessToken: () => Effect.succeed(Redacted.make("fixture")),
    models: () => Effect.succeed([]),
    disconnect: () => Effect.succeed({ revocation: "NotNeeded" })
  })
)
it("preserves reported zeros and cache subsets while rejecting invalid optional token observations", () => {
  expect(reportedTokens({ input_tokens: 0, output_tokens: 0, input_tokens_details: { cached_tokens: 0 } })).toEqual({
    input: 0,
    output: 0,
    cachedInput: 0
  })
  expect(
    reportedTokens({
      input_tokens: 100,
      output_tokens: 20,
      input_tokens_details: { cached_tokens: 80 },
      output_tokens_details: { reasoning_tokens: 5 }
    })
  ).toEqual({ input: 100, output: 20, cachedInput: 80, reasoningOutput: 5 })
  for (const value of [
    undefined,
    null,
    { input_tokens: -1 },
    { input_tokens: 1, input_tokens_details: { cached_tokens: 2 } },
    { output_tokens: 1, output_tokens_details: { reasoning_tokens: 2 } }
  ])
    expect(reportedTokens(value)).toBeUndefined()
  expect(reportedTokens({})).toEqual({})
})
it("records separate actual subscription calls and summaries through the real SSE adapter and SQLite", async () => {
  const fixture = await temporaryDatabase()
  try {
    const accounting = sqliteUsageLayer(fixture.path)
    const transport = async () =>
      new Response(
        frame({ type: "response.output_text.delta", delta: "fixture" }) +
          frame({
            type: "response.completed",
            response: {
              status: "completed",
              output: [],
              usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 80 } }
            }
          })
      )
    const inference = Layer.merge(
      subscriptionInferenceLayer(transport),
      subscriptionToolInferenceLayer(transport)
    ).pipe(Layer.provide(subscription), Layer.provideMerge(accounting))
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const provider = yield* SubscriptionInference
          const tools = yield* SubscriptionToolInference
          for (let round = 0; round < 2; round++) {
            yield* Stream.runDrain(
              tools.generate({
                model: "gpt-6.1-sol",
                instructions: "fixture",
                input: [{ role: "user", content: "synthetic private text" }],
                tools: [],
                toolChoice: "auto"
              })
            )
          }
          yield* Stream.runDrain(
            provider.generate({ model: "gpt-6-luna", instructions: "fixture", input: "synthetic" })
          )
          const ledger = yield* UsageLedger
          const snapshot = yield* ledger.read
          expect(snapshot.totals).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                category: "chat",
                attempts: 2,
                input: 200,
                cachedInput: 160,
                output: 40,
                unreported: 0
              }),
              expect.objectContaining({ category: "memory", attempts: 1, input: 100, cachedInput: 80, output: 20 })
            ])
          )
          expect(snapshot.recent.map((attempt) => attempt.outcome)).toEqual(["completed", "completed", "completed"])
          expect(JSON.stringify(snapshot)).not.toContain("synthetic private text")
        })
      ).pipe(Effect.provide(inference))
    )
    const restored = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          return yield* (yield* UsageLedger).read
        })
      ).pipe(Effect.provide(sqliteUsageLayer(fixture.path)))
    )
    expect(restored.totals.map((value) => value.attempts)).toEqual([2, 1])
  } finally {
    await fixture.close()
  }
})
it("settles cancelled and failed attempts, keeps missing counters unknown, and does not double count replay", async () => {
  const fixture = await temporaryDatabase()
  const pending = {
    id: randomUUID(),
    category: "chat",
    model: "gpt-6.1-sol",
    startedAt: 1,
    outcome: "running",
    tokens: {}
  } as const
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ledger = yield* UsageLedger
          yield* ledger.record(pending)
          yield* ledger.record({ ...pending, outcome: "completed", tokens: { input: 0, cachedInput: 0, output: 0 } })
          yield* ledger.record({ ...pending, outcome: "completed", tokens: { input: 999 } })
          yield* Stream.runDrain(trackInferenceUsage(Stream.fail("fixture"), "gpt-6-luna", ledger, "memory")).pipe(
            Effect.exit
          )
          const fiber = yield* Stream.runDrain(trackInferenceUsage(Stream.never, "gpt-6.1-sol", ledger)).pipe(
            Effect.forkScoped
          )
          yield* Effect.yieldNow
          yield* Fiber.interrupt(fiber)
          const snapshot = yield* ledger.read
          expect(snapshot.recent.map((value) => value.outcome)).toEqual(
            expect.arrayContaining(["completed", "failed", "interrupted"])
          )
          expect(snapshot.totals.find((value) => value.category === "memory")).toMatchObject({
            input: null,
            cachedInput: null,
            output: null,
            unreported: 1
          })
          expect(snapshot.totals.find((value) => value.category === "chat")).toMatchObject({
            attempts: 2,
            input: 0,
            output: 0,
            unreported: 1
          })
          yield* ledger.record({ ...pending, id: randomUUID() })
          expect(Exit.isFailure(yield* ledger.record({ ...pending, id: "invalid" }).pipe(Effect.exit))).toBe(true)
          expect((yield* ledger.read).degraded).toBe(true)
        })
      ).pipe(Effect.provide(sqliteUsageLayer(fixture.path)))
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const snapshot = yield* (yield* UsageLedger).read
          expect(snapshot.degraded).toBe(true)
          expect(snapshot.recent.some((value) => value.outcome === "running")).toBe(false)
          expect(snapshot.recent.filter((value) => value.outcome === "interrupted")).toHaveLength(2)
        })
      ).pipe(Effect.provide(sqliteUsageLayer(fixture.path)))
    )
  } finally {
    await fixture.close()
  }
})
const speechModel = {
  model: "tts-rt-v2",
  total_api_cost_usd: "0.1273980000",
  total_num_requests: 194,
  total_input_text_tokens: 2,
  total_input_audio_tokens: 0,
  total_output_text_tokens: 0,
  total_output_audio_tokens: 3,
  total_input_audio_duration_ms: 0,
  total_output_audio_duration_ms: 622098
}
it("reads bounded project billing without losing decimal precision and classifies credential/transport failures", async () => {
  const key = Redacted.make("private-fixture-key")
  const now = Date.UTC(2026, 9, 18)
  const load = (response: () => Promise<Response>, selected: typeof key | undefined = key) =>
    Effect.runPromise(sonioxUsage(selected, now, response))
  expect((await Effect.runPromise(sonioxUsage(undefined, now))).status).toBe("notConfigured")
  const result = await load(async () => Response.json({ models: [speechModel, { ...speechModel, model: "other" }] }))
  expect(result.models).toEqual([speechModel])
  expect(result.scope).toMatch(/^[0-9a-f]{32}$/)
  expect(JSON.stringify(result)).not.toContain("private-fixture-key")
  for (const [status, expected] of [
    [401, "authentication"],
    [403, "permission"],
    [500, "unavailable"]
  ] as const) {
    expect((await load(async () => new Response(null, { status }))).status).toBe(expected)
  }
  for (const response of [
    async () => Response.json({ models: [{ ...speechModel, total_api_cost_usd: -1 }] }),
    async () => new Response(null),
    async () => new Response("x".repeat(1048577)),
    async (): Promise<Response> => {
      throw new Error("private upstream detail")
    }
  ]) {
    expect((await load(response)).status).toBe("unavailable")
  }
  expect(Exit.isSuccess(await Effect.runPromiseExit(sonioxUsage(undefined, now)))).toBe(true)
})

it("retains usage from failed provider responses before the stream raises its typed error", async () => {
  const fixture = await temporaryDatabase()
  try {
    const accounting = sqliteUsageLayer(fixture.path)
    const response = async () =>
      new Response(
        frame({
          type: "response.incomplete",
          response: { usage: { input_tokens: 30, output_tokens: 4, input_tokens_details: { cached_tokens: 10 } } }
        })
      )
    const providers = Layer.merge(subscriptionInferenceLayer(response), subscriptionToolInferenceLayer(response)).pipe(
      Layer.provide(subscription),
      Layer.provideMerge(accounting)
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const memory = yield* SubscriptionInference
          const chat = yield* SubscriptionToolInference
          yield* Stream.runDrain(
            memory.generate({ model: "gpt-6-luna", instructions: "fixture", input: "fixture" })
          ).pipe(Effect.exit)
          yield* Stream.runDrain(
            chat.generate({ model: "gpt-6.1-sol", instructions: "fixture", input: [], tools: [], toolChoice: "auto" })
          ).pipe(Effect.exit)
          const snapshot = yield* (yield* UsageLedger).read
          expect(snapshot.recent).toHaveLength(2)
          expect(
            snapshot.recent.every(
              (value) =>
                value.outcome === "failed" &&
                value.tokens.input === 30 &&
                value.tokens.cachedInput === 10 &&
                value.tokens.output === 4
            )
          ).toBe(true)
        })
      ).pipe(Effect.provide(providers))
    )
  } finally {
    await fixture.close()
  }
})

it("does not count an authentication failure as a dispatched provider request", async () => {
  const fixture = await temporaryDatabase()
  try {
    const unavailable = Layer.unwrap(
      Effect.gen(function* () {
        const service = yield* Subscription
        return Layer.succeed(Subscription, {
          ...service,
          accessToken: () => Effect.fail(new SubscriptionFailed({ kind: "Authentication", message: "fixture" }))
        })
      })
    ).pipe(Layer.provide(subscription))
    const provider = subscriptionInferenceLayer(async () => {
      throw new Error("Transport must not run before authentication")
    }).pipe(Layer.provide(unavailable), Layer.provideMerge(sqliteUsageLayer(fixture.path)))
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const inference = yield* SubscriptionInference
          const result = yield* Stream.runDrain(
            inference.generate({ model: "gpt-6-luna", instructions: "fixture", input: "fixture" })
          ).pipe(Effect.exit)
          expect(Exit.isFailure(result)).toBe(true)
          expect((yield* (yield* UsageLedger).read).totals).toEqual([])
        })
      ).pipe(Effect.provide(provider))
    )
  } finally {
    await fixture.close()
  }
})
