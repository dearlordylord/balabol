import { Effect, Layer } from "effect"
import type { AnswerFailed, AnswerGeneration } from "../src/answer-generation/index.ts"
import { fakeSummaryLayer, type SummaryGeneration } from "../src/summary-generation/index.ts"
import { Conversation, ReplyConfiguration, defaultReplySettings } from "../src/conversation/index.ts"
import { configuredUniiLayer, sqliteLayer } from "../src/memory/index.ts"

export const replyLayer = (
  path: string,
  answer: Layer.Layer<AnswerGeneration, AnswerFailed>,
  overrides: Partial<typeof defaultReplySettings> = {},
  summary: Layer.Layer<SummaryGeneration> = fakeSummaryLayer
) =>
  Conversation.configuredLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        answer,
        Layer.succeed(ReplyConfiguration, { ...defaultReplySettings, deltaMillis: 0, ...overrides }),
        configuredUniiLayer().pipe(Layer.provide(summary), Layer.provide(sqliteLayer(path)))
      )
    )
  )
const maximumPolls = 300
const pollMillis = 5
export const waitForReply = (conversation: Conversation["Service"], inputDeliveryId: string) =>
  Effect.gen(function* () {
    let reply = yield* conversation.reply(inputDeliveryId)
    for (
      let attempt = 0;
      (reply.state === "Waiting" || reply.state === "Streaming") && attempt < maximumPolls;
      attempt++
    ) {
      yield* Effect.sleep(pollMillis)
      reply = yield* conversation.reply(inputDeliveryId)
    }
    return reply
  })
