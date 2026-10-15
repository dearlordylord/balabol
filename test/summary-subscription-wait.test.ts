import { it } from "@effect/vitest"
import { Effect, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vitest"
import { fakeAnswerLayer } from "../src/answer-generation/index.ts"
import { parseConfig } from "../src/bootstrap/index.ts"
import { Conversation, ReplyConfiguration } from "../src/conversation/index.ts"
import { configuredUniiLayer, sqliteLayer } from "../src/memory/index.ts"
import { subscriptionSummaryLayer } from "../src/summary-generation/index.ts"
import { SubscriptionInference } from "../src/subscription/index.ts"
import type { InferenceEvent } from "../src/subscription/index.ts"
import { temporaryDatabase } from "./memory-fixture.ts"
it.effect(
  "real-summary waiting survives a seven-second Luna job and starts the answer as soon as memory is ready",
  () =>
    Effect.gen(function* () {
      const database = yield* Effect.tryPromise(temporaryDatabase)
      const config = yield* parseConfig({ BALABOL_SUMMARY_PROVIDER: "subscription" })
      if (config.memory === undefined || config.reply === undefined)
        return yield* Effect.die("Missing parsed configuration")
      const summary = subscriptionSummaryLayer.pipe(
        Layer.provide(
          Layer.succeed(SubscriptionInference, {
            generate: () =>
              Stream.fromEffect(
                Effect.sleep(7000).pipe(Effect.as<InferenceEvent>({ kind: "Delta", text: "Concise trusted memory." }))
              ).pipe(Stream.concat(Stream.succeed<InferenceEvent>({ kind: "Completed" })))
          })
        )
      )
      const application = Conversation.configuredLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            fakeAnswerLayer(0),
            Layer.succeed(ReplyConfiguration, config.reply),
            configuredUniiLayer(config.memory).pipe(Layer.provide(summary), Layer.provide(sqliteLayer(database.path)))
          )
        )
      )
      const first = {
        deliveryId: "11111111-1111-4111-8111-111111111111",
        text: "Synthetic earlier memory. ".repeat(50)
      }
      const second = { deliveryId: "22222222-2222-4222-8222-222222222222", text: "Synthetic current input." }
      yield* Effect.scoped(
        Effect.gen(function* () {
          const conversation = yield* Conversation
          yield* conversation.send(first)
          yield* TestClock.adjust(10)
          yield* conversation.send(second)
          yield* conversation.observeReply(second.deliveryId)
          yield* TestClock.adjust(6500)
          expect((yield* conversation.reply(second.deliveryId)).state).toBe("Waiting")
          yield* TestClock.adjust(1000)
          expect((yield* conversation.reply(second.deliveryId)).state).toBe("Completed")
        }).pipe(Effect.provide(application))
      ).pipe(Effect.ensuring(Effect.tryPromise(() => database.close()).pipe(Effect.orDie)))
    })
)
