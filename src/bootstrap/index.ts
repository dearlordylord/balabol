import { createServer } from "node:http"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { NodeHttpServer } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/http"
import {
  Conversation,
  conversationRoutes,
  ReplySettings,
  ReplyConfiguration,
  defaultReplySettings
} from "../conversation/index.ts"

import { welcomeRoutes } from "./welcome.ts"
import { configuredUniiLayer, sqliteLayer, MemorySettings, defaultMemorySettings } from "../memory/index.ts"

import { fakeAnswerLayer } from "../answer-generation/index.ts"
import { fakeSummaryLayer } from "../summary-generation/index.ts"
export const conversationLayer = (
  path: string,
  settings: ReplySettings = defaultReplySettings,
  memorySettings: MemorySettings = defaultMemorySettings
) =>
  Conversation.configuredLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        fakeAnswerLayer(settings.deltaMillis),
        Layer.succeed(ReplyConfiguration, settings),
        configuredUniiLayer(memorySettings).pipe(Layer.provide(fakeSummaryLayer), Layer.provide(sqliteLayer(path)))
      )
    )
  )
const maximumPort = 65_535
export const ServerConfig = Schema.Struct({
  host: Schema.String.check(Schema.isMinLength(1)),
  port: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(maximumPort)),
  database: Schema.String.check(Schema.isMinLength(1)),
  memory: Schema.optionalKey(MemorySettings),
  reply: Schema.optionalKey(ReplySettings)
})
export type ServerConfig = typeof ServerConfig.Type
const providerSelection = (environment: NodeJS.ProcessEnv) => ({
  answerProvider: environment.BALABOL_ANSWER_PROVIDER ?? "fake",
  answerModel: environment.BALABOL_ANSWER_MODEL ?? "sol"
})
const replyTiming = (environment: NodeJS.ProcessEnv) => ({
  deltaMillis: Number(environment.BALABOL_FAKE_DELTA_MILLIS ?? "80"),
  contextWaitAttempts: Number(environment.BALABOL_PRIOR_CONTEXT_WAIT_ATTEMPTS ?? "100"),
  contextWaitMillis: Number(environment.BALABOL_PRIOR_CONTEXT_WAIT_MILLIS ?? "20"),
  attachmentMillis: Number(environment.BALABOL_REPLY_ATTACHMENT_MILLIS ?? "5000")
})
export const parseConfig = (environment: NodeJS.ProcessEnv) =>
  Schema.decodeUnknownEffect(ServerConfig)({
    host: environment.BALABOL_HOST ?? "127.0.0.1",
    port: Number(environment.BALABOL_PORT ?? "8787"),
    database: environment.BALABOL_DATABASE ?? ".data/conversation.sqlite",
    memory: {
      summaryProvider: environment.BALABOL_SUMMARY_PROVIDER ?? "fake",
      summaryModel: environment.BALABOL_SUMMARY_MODEL ?? "luna",
      summaryConcurrency: Number(environment.BALABOL_SUMMARY_CONCURRENCY ?? "1")
    },
    reply: { ...providerSelection(environment), ...replyTiming(environment) }
  })
export const serverLayer = (config: ServerConfig) =>
  HttpRouter.serve(Layer.merge(conversationRoutes, welcomeRoutes)).pipe(
    Layer.provide(conversationLayer(config.database, config.reply, config.memory)),
    Layer.provideMerge(NodeHttpServer.layer(createServer, { host: config.host, port: config.port }))
  )
export const prepareDataDirectory = (config: ServerConfig) =>
  Effect.tryPromise(() => mkdir(dirname(config.database), { recursive: true }))
