import { it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vitest"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { parseConfig } from "../src/bootstrap/index.ts"
import { Conversation, Reply, ReplyConfiguration, defaultReplySettings } from "../src/conversation/index.ts"
import { configuredUniiLayer, defaultMemorySettings, sqliteLayer } from "../src/memory/index.ts"
import { SummaryGeneration } from "../src/summary-generation/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"

for (const concurrency of [1, 2])
  it.effect(`limits real unii summary jobs to configured concurrency ${concurrency}`, () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.tryPromise(temporaryDatabase)
      let active = 0
      let maximum = 0
      const summary = Layer.succeed(SummaryGeneration, {
        summarize: () =>
          Effect.acquireUseRelease(
            Effect.sync(() => {
              active++
              maximum = Math.max(maximum, active)
            }),
            () => Effect.sleep(1000).pipe(Effect.as("complete deterministic summary")),
            () =>
              Effect.sync(() => {
                active--
              })
          )
      })
      const layer = Conversation.configuredLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            fakeAnswerLayer(0),
            Layer.succeed(ReplyConfiguration, defaultReplySettings),
            configuredUniiLayer({ ...defaultMemorySettings, summaryConcurrency: concurrency }).pipe(
              Layer.provide(summary),
              Layer.provide(sqliteLayer(fixture.path))
            )
          )
        )
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          const identities = [
            "11111111-1111-4111-8111-111111111111",
            "22222222-2222-4222-8222-222222222222",
            "33333333-3333-4333-8333-333333333333"
          ]
          for (const deliveryId of identities) {
            yield* conversation.send({ deliveryId, text: "long source requiring actual summary work ".repeat(100) })
            yield* conversation.cancelReply(deliveryId)
          }
          yield* TestClock.adjust(10)
          expect(maximum).toBe(concurrency)
          expect(active).toBe(concurrency)
          yield* TestClock.adjust(5000)
          expect(maximum).toBe(concurrency)
          expect(active).toBe(0)
        }).pipe(Effect.provide(layer))
      ).pipe(Effect.ensuring(Effect.tryPromise(() => fixture.close()).pipe(Effect.orDie)))
    })
  )

it.effect("rejects unsupported summary admission and identical response/input identities", () =>
  Effect.gen(function* () {
    for (const value of ["0", "9", "1.5", "invalid"])
      expect((yield* Effect.result(parseConfig({ BALABOL_SUMMARY_CONCURRENCY: value })))._tag).toBe("Failure")
    expect((yield* Effect.result(parseConfig({ BALABOL_ANSWER_MODEL: "a".repeat(201) })))._tag).toBe("Failure")
    const defaults = yield* parseConfig({})
    expect(defaults.memory?.summaryConcurrency).toBe(1)
    expect(() =>
      Schema.decodeUnknownSync(Reply)({
        responseId: "11111111-1111-4111-8111-111111111111",
        inputDeliveryId: "11111111-1111-4111-8111-111111111111",
        sequence: 0,
        state: "Waiting",
        text: "",
        error: null,
        receipt: null
      })
    ).toThrow()
  })
)
