import { createServer } from "node:http"
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
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

import { LanguageTags } from "../language/index.ts"
import { welcomeRoutes } from "./welcome.ts"
import {
  configuredUniiLayer,
  sqliteStorageLayer,
  durableMemoryLayer,
  SqliteMemoryStorage,
  MemorySettings,
  defaultMemorySettings
} from "../memory/index.ts"

import { fakeAnswerLayer, subscriptionAnswerLayer } from "../answer-generation/index.ts"
import {
  FakeSummarySettings,
  configurableFakeSummaryLayer,
  subscriptionSummaryLayer
} from "../summary-generation/index.ts"
import { fakeRecognitionLayer, qwenRecognitionLayer, QwenSettings } from "../speech-recognition/index.ts"
import { fakeSynthesisLayer, appleSynthesisLayer, AppleSynthesisSettings } from "../speech-synthesis/index.ts"
import {
  LiveKitSettings,
  liveKitLayer,
  Voice,
  voiceRoutes,
  sqliteVoiceAdmissions,
  VoiceLanguageConfiguration,
  defaultVoiceLanguageConfiguration,
  VoiceOutputConfiguration,
  VoiceOutputSettings,
  defaultVoiceOutputSettings,
  localSpeechVoiceOutputSettings,
  SpeechActivitySettings,
  fakeSpeechActivityLayer,
  sileroSpeechActivityLayer,
  speechActivityModel,
  voiceDiagnosticsLayer,
  voiceDiagnosticFile,
  VoiceDiagnostics
} from "../voice/index.ts"
import { sqliteDictionaryLayer } from "../dictionary/index.ts"
import { sqliteKnowledgeLayer } from "../personal-knowledge/index.ts"
import { subscriptionLayer, subscriptionInferenceLayer, subscriptionToolInferenceLayer } from "../subscription/index.ts"
import { trustedControlRoutes } from "./control-access.ts"
const defaultDictionaryPath = join(homedir(), ".local", "share", "balabol", "dictionaries", "wiktionary.sqlite")
const sharedKnowledgeLayer = Layer.unwrap(
  Effect.gen(function* () {
    const resource = yield* SqliteMemoryStorage
    return sqliteKnowledgeLayer(resource.storage.database)
  })
)
const configuredAnswerLayer = (settings: ReplySettings, dictionaryPath: string) =>
  settings.answerProvider === "subscription"
    ? subscriptionAnswerLayer().pipe(
        Layer.provide(sharedKnowledgeLayer),
        Layer.provide(sqliteDictionaryLayer(dictionaryPath))
      )
    : fakeAnswerLayer(settings.deltaMillis)
const configuredConversationLayer = (
  settings: ReplySettings = defaultReplySettings,
  memorySettings: MemorySettings = defaultMemorySettings,
  summarySettings?: FakeSummarySettings,
  subscriptionDirectory = join(homedir(), ".local", "share", "balabol", "subscription"),
  dictionaryPath = defaultDictionaryPath
) => {
  const answer = configuredAnswerLayer(settings, dictionaryPath)
  const summary =
    memorySettings.summaryProvider === "subscription"
      ? subscriptionSummaryLayer
      : configurableFakeSummaryLayer(summarySettings)
  const providers = Layer.merge(answer, summary)
  const selected =
    settings.answerProvider === "subscription" || memorySettings.summaryProvider === "subscription"
      ? providers.pipe(
          Layer.provide(Layer.merge(subscriptionInferenceLayer(), subscriptionToolInferenceLayer())),
          Layer.provide(subscriptionLayer(subscriptionDirectory))
        )
      : Layer.merge(fakeAnswerLayer(settings.deltaMillis), configurableFakeSummaryLayer(summarySettings))
  return Conversation.configuredLayer.pipe(
    Layer.provide(
      Layer.mergeAll(Layer.succeed(ReplyConfiguration, settings), configuredUniiLayer(memorySettings)).pipe(
        Layer.provideMerge(selected)
      )
    )
  )
}
export const conversationLayer = (
  path: string,
  settings: ReplySettings = defaultReplySettings,
  memorySettings: MemorySettings = defaultMemorySettings,
  summarySettings?: FakeSummarySettings,
  subscriptionDirectory = join(homedir(), ".local", "share", "balabol", "subscription"),
  dictionaryPath = defaultDictionaryPath
) =>
  configuredConversationLayer(settings, memorySettings, summarySettings, subscriptionDirectory, dictionaryPath).pipe(
    Layer.provide(durableMemoryLayer),
    Layer.provide(sqliteStorageLayer(path))
  )
const maximumPort = 65_535
const maximumOwnerIdentityLength = 254
// Four seconds of fixture audio makes interruption observable without inference.
const fixtureSynthesisFrames = 96_000
export const ServerConfig = Schema.Struct({
  host: Schema.String.check(Schema.isMinLength(1)),
  port: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(maximumPort)),
  database: Schema.String.check(Schema.isMinLength(1)),
  subscriptionDirectory: Schema.optionalKey(Schema.NonEmptyString),
  dictionaryPath: Schema.optionalKey(Schema.NonEmptyString),
  memory: Schema.optionalKey(MemorySettings),
  fakeSummary: Schema.optionalKey(FakeSummarySettings),
  reply: Schema.optionalKey(ReplySettings),
  voice: Schema.optionalKey(LiveKitSettings),
  voiceDiagnostics: Schema.optionalKey(Schema.Boolean),
  voiceLanguages: Schema.optionalKey(LanguageTags),
  recognition: Schema.optionalKey(QwenSettings),
  activity: Schema.optionalKey(SpeechActivitySettings),
  synthesis: Schema.optionalKey(AppleSynthesisSettings),
  voiceOutput: Schema.optionalKey(VoiceOutputSettings),
  tailnetOwner: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximumOwnerIdentityLength))
  )
}).check(
  Schema.makeFilter((config) => config.voice === undefined || ["127.0.0.1", "::1", "localhost"].includes(config.host))
)
export type ServerConfig = typeof ServerConfig.Type
const providerSelection = (environment: NodeJS.ProcessEnv) => ({
  answerProvider: environment.BALABOL_ANSWER_PROVIDER ?? "fake",
  answerModel:
    environment.BALABOL_ANSWER_MODEL ?? (environment.BALABOL_ANSWER_PROVIDER === "subscription" ? "gpt-6.1-sol" : "sol")
})
const replyTiming = (environment: NodeJS.ProcessEnv) => ({
  deltaMillis: Number(environment.BALABOL_FAKE_DELTA_MILLIS ?? "80"),
  contextWaitAttempts: Number(
    environment.BALABOL_PRIOR_CONTEXT_WAIT_ATTEMPTS ??
      (environment.BALABOL_SUMMARY_PROVIDER === "subscription" ? "600" : "100")
  ),
  contextWaitMillis: Number(
    environment.BALABOL_PRIOR_CONTEXT_WAIT_MILLIS ??
      (environment.BALABOL_SUMMARY_PROVIDER === "subscription" ? "100" : "20")
  ),
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
const languageSelection = (environment: NodeJS.ProcessEnv) => ({
  voiceLanguages:
    environment.BALABOL_VOICE_LANGUAGES?.split(",").map((tag) => tag.trim()) ??
    defaultVoiceLanguageConfiguration.allowedLanguages
})
const summarySelection = (environment: NodeJS.ProcessEnv) => ({
  summaryProvider: environment.BALABOL_SUMMARY_PROVIDER ?? "fake",
  summaryModel:
    environment.BALABOL_SUMMARY_MODEL ??
    (environment.BALABOL_SUMMARY_PROVIDER === "subscription" ? "gpt-6-luna" : "luna"),
  summaryConcurrency: Number(environment.BALABOL_SUMMARY_CONCURRENCY ?? "1")
})
const subscriptionSelection = (environment: NodeJS.ProcessEnv) => ({
  subscriptionDirectory:
    environment.BALABOL_SUBSCRIPTION_DIRECTORY ?? join(homedir(), ".local", "share", "balabol", "subscription")
})
const outputSelection = (environment: NodeJS.ProcessEnv) => ({
  voiceOutput: {
    completionMillis: Number(
      environment.BALABOL_VOICE_COMPLETION_MILLIS ??
        String(
          (environment.BALABOL_SYNTHESIS_PROVIDER === "apple"
            ? localSpeechVoiceOutputSettings
            : defaultVoiceOutputSettings
          ).completionMillis
        )
    )
  }
})
const activitySelection = (environment: NodeJS.ProcessEnv) => ({
  activity: {
    provider:
      environment.BALABOL_ACTIVITY_PROVIDER ??
      (environment.BALABOL_RECOGNITION_PROVIDER === "qwen3-asr" ? "silero" : "fake"),
    modelPath:
      environment.BALABOL_VAD_MODEL ??
      join(homedir(), ".local", "share", "balabol", "models", "vad", speechActivityModel.filename)
  }
})
const speechSelection = (environment: NodeJS.ProcessEnv) => ({
  recognition: {
    provider: environment.BALABOL_RECOGNITION_PROVIDER ?? "fake",
    executable:
      environment.BALABOL_QWEN_PYTHON_PATH ??
      join(homedir(), ".local", "share", "balabol", "tools", "qwen-asr", ".venv", "bin", "python"),
    helperPath: environment.BALABOL_QWEN_HELPER_PATH ?? join(process.cwd(), "scripts", "qwen-asr.py"),
    modelPath:
      environment.BALABOL_QWEN_MODEL ?? join(homedir(), ".local", "share", "balabol", "models", "qwen3-asr-1.7b")
  },
  synthesis: {
    provider: environment.BALABOL_SYNTHESIS_PROVIDER ?? "fake",
    helperExecutable:
      environment.BALABOL_APPLE_SPEECH_EXECUTABLE ??
      join(homedir(), ".local", "share", "balabol", "tools", "apple-speech", "apple-speech"),
    ffmpegExecutable: environment.BALABOL_FFMPEG_EXECUTABLE ?? "/opt/homebrew/bin/ffmpeg"
  }
})
export const parseConfig = (environment: NodeJS.ProcessEnv) =>
  Schema.decodeUnknownEffect(ServerConfig)({
    voiceDiagnostics: environment.BALABOL_VOICE_DIAGNOSTICS === "1",
    host: environment.BALABOL_HOST ?? "127.0.0.1",
    port: Number(environment.BALABOL_PORT ?? "8787"),
    database: environment.BALABOL_DATABASE ?? ".data/conversation.sqlite",
    dictionaryPath: environment.BALABOL_DICTIONARY_PATH ?? defaultDictionaryPath,
    ...subscriptionSelection(environment),
    memory: summarySelection(environment),
    fakeSummary: {
      failFirstJob: environment.BALABOL_FAKE_SUMMARY_FAIL_FIRST_JOB === "true",
      delayMillis: Number(environment.BALABOL_FAKE_SUMMARY_DELAY_MILLIS ?? "0"),
      invalidCompletion: environment.BALABOL_FAKE_SUMMARY_INVALID === "true"
    },
    reply: { ...providerSelection(environment), ...replyTiming(environment) },
    ...languageSelection(environment),
    ...speechSelection(environment),
    ...activitySelection(environment),
    ...outputSelection(environment),
    ...voiceSelection(environment),
    ...tailnetSelection(environment)
  })
const selectedSynthesis = (config: ServerConfig) =>
  config.synthesis?.provider === "apple"
    ? appleSynthesisLayer(config.synthesis, config.voiceLanguages ?? defaultVoiceLanguageConfiguration.allowedLanguages)
    : fakeSynthesisLayer({ sampleFrames: fixtureSynthesisFrames })
const selectedSpeechActivity = (config: ServerConfig) => {
  const provider = config.activity?.provider ?? (config.recognition?.provider === "qwen3-asr" ? "silero" : "fake")
  return provider === "silero"
    ? sileroSpeechActivityLayer({
        modelPath:
          config.activity?.modelPath ??
          join(homedir(), ".local", "share", "balabol", "models", "vad", speechActivityModel.filename)
      })
    : fakeSpeechActivityLayer
}
export const serverLayer = (config: ServerConfig) => {
  const conversation = conversationLayer(
    config.database,
    config.reply,
    config.memory,
    config.fakeSummary,
    config.subscriptionDirectory,
    config.dictionaryPath
  )
  const http = NodeHttpServer.layer(createServer, { host: config.host, port: config.port })
  if (config.voice === undefined)
    return HttpRouter.serve(
      trustedControlRoutes(Layer.merge(conversationRoutes, welcomeRoutes), config.tailnetOwner)
    ).pipe(Layer.provide(conversation), Layer.provideMerge(http))
  const routes = Layer.mergeAll(conversationRoutes, welcomeRoutes, voiceRoutes)
  // One scoped writer lease protects both memory and speech-admission facts.
  const storage = sqliteStorageLayer(config.database)
  const sharedConversation = configuredConversationLayer(
    config.reply,
    config.memory,
    config.fakeSummary,
    config.subscriptionDirectory,
    config.dictionaryPath
  ).pipe(Layer.provide(durableMemoryLayer))
  const admissions = Layer.unwrap(
    Effect.gen(function* () {
      const resource = yield* SqliteMemoryStorage
      return sqliteVoiceAdmissions(resource.storage.database)
    })
  )
  const diagnostics =
    config.voiceDiagnostics === true
      ? voiceDiagnosticsLayer(
          voiceDiagnosticFile(join(homedir(), ".local", "share", "balabol", "diagnostics", "backend.json"))
        )
      : Layer.succeed(VoiceDiagnostics, { record: () => {} })
  const application = Voice.configuredLayer.pipe(
    Layer.provide(diagnostics),
    Layer.provide(
      Layer.succeed(VoiceLanguageConfiguration, {
        allowedLanguages: config.voiceLanguages ?? defaultVoiceLanguageConfiguration.allowedLanguages
      })
    ),
    Layer.provide(
      config.recognition?.provider === "qwen3-asr" ? qwenRecognitionLayer(config.recognition) : fakeRecognitionLayer()
    ),
    Layer.provide(selectedSynthesis(config)),
    Layer.provide(selectedSpeechActivity(config)),
    Layer.provide(Layer.succeed(VoiceOutputConfiguration, config.voiceOutput ?? defaultVoiceOutputSettings)),
    Layer.provide(liveKitLayer(config.voice)),
    Layer.provide(admissions),
    Layer.provideMerge(sharedConversation),
    Layer.provide(storage)
  )
  return HttpRouter.serve(trustedControlRoutes(routes, config.tailnetOwner)).pipe(
    Layer.provide(application),
    Layer.provideMerge(http)
  )
}
export const prepareDataDirectory = (config: ServerConfig) =>
  Effect.tryPromise(() => mkdir(dirname(config.database), { recursive: true }))
