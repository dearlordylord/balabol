import { createServer } from "node:http"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { NodeHttpServer } from "@effect/platform-node"
import { Effect, Layer, Redacted, Schema } from "effect"
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
import { FakeSummarySettings, configurableFakeSummaryLayer } from "../summary-generation/index.ts"
import { fakeRecognitionLayer } from "../speech-recognition/index.ts"
import { LiveKitSettings, liveKitLayer, Voice, voiceRoutes } from "../voice/index.ts"
import { trustedControlRoutes } from "./control-access.ts"
export const conversationLayer = (
  path: string,
  settings: ReplySettings = defaultReplySettings,
  memorySettings: MemorySettings = defaultMemorySettings,
  summarySettings?: FakeSummarySettings
) =>
  Conversation.configuredLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        fakeAnswerLayer(settings.deltaMillis),
        Layer.succeed(ReplyConfiguration, settings),
        configuredUniiLayer(memorySettings).pipe(
          Layer.provide(configurableFakeSummaryLayer(summarySettings)),
          Layer.provide(sqliteLayer(path))
        )
      )
    )
  )
const maximumPort = 65_535
const maximumOwnerIdentityLength = 254
export const ServerConfig = Schema.Struct({
  host: Schema.String.check(Schema.isMinLength(1)),
  port: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(maximumPort)),
  database: Schema.String.check(Schema.isMinLength(1)),
  memory: Schema.optionalKey(MemorySettings),
  fakeSummary: Schema.optionalKey(FakeSummarySettings),
  reply: Schema.optionalKey(ReplySettings),
  voice: Schema.optionalKey(LiveKitSettings),
  tailnetOwner: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximumOwnerIdentityLength))
  )
}).check(
  Schema.makeFilter((config) => config.voice === undefined || ["127.0.0.1", "::1", "localhost"].includes(config.host))
)
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
const voiceSelection = (environment: NodeJS.ProcessEnv) =>
  [
    environment.BALABOL_LIVEKIT_URL,
    environment.BALABOL_LIVEKIT_MEDIA_URL,
    environment.BALABOL_LIVEKIT_API_KEY,
    environment.BALABOL_LIVEKIT_API_SECRET
  ].every((value) => value === undefined)
    ? {}
    : {
        voice: {
          url: environment.BALABOL_LIVEKIT_URL ?? "",
          mediaUrl: environment.BALABOL_LIVEKIT_MEDIA_URL ?? environment.BALABOL_LIVEKIT_URL ?? "",
          apiKey: environment.BALABOL_LIVEKIT_API_KEY ?? "",
          apiSecret: Redacted.make(environment.BALABOL_LIVEKIT_API_SECRET ?? "")
        }
      }
const tailnetSelection = (environment: NodeJS.ProcessEnv) =>
  environment.BALABOL_TAILNET_OWNER === undefined ? {} : { tailnetOwner: environment.BALABOL_TAILNET_OWNER }
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
    fakeSummary: {
      failFirstJob: environment.BALABOL_FAKE_SUMMARY_FAIL_FIRST_JOB === "true",
      delayMillis: Number(environment.BALABOL_FAKE_SUMMARY_DELAY_MILLIS ?? "0"),
      invalidCompletion: environment.BALABOL_FAKE_SUMMARY_INVALID === "true"
    },
    reply: { ...providerSelection(environment), ...replyTiming(environment) },
    ...voiceSelection(environment),
    ...tailnetSelection(environment)
  })
export const serverLayer = (config: ServerConfig) => {
  const conversation = conversationLayer(config.database, config.reply, config.memory, config.fakeSummary)
  const http = NodeHttpServer.layer(createServer, { host: config.host, port: config.port })
  if (config.voice === undefined)
    return HttpRouter.serve(
      trustedControlRoutes(Layer.merge(conversationRoutes, welcomeRoutes), config.tailnetOwner)
    ).pipe(Layer.provide(conversation), Layer.provideMerge(http))
  const routes = Layer.mergeAll(conversationRoutes, welcomeRoutes, voiceRoutes)
  const application = Voice.layer.pipe(
    Layer.provide(fakeRecognitionLayer()),
    Layer.provide(liveKitLayer(config.voice)),
    Layer.provideMerge(conversation)
  )
  return HttpRouter.serve(trustedControlRoutes(routes, config.tailnetOwner)).pipe(
    Layer.provide(application),
    Layer.provideMerge(http)
  )
}
export const prepareDataDirectory = (config: ServerConfig) =>
  Effect.tryPromise(() => mkdir(dirname(config.database), { recursive: true }))
