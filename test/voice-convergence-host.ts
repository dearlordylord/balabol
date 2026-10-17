import { createServer } from "node:http"
import { NodeHttpServer } from "@effect/platform-node"
import { Clock, Deferred, Effect, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { AnswerGeneration, fakeAnswerLayer } from "../src/answer-generation/index.ts"
import {
  Conversation,
  conversationRoutes,
  ReplyConfiguration,
  defaultReplySettings
} from "../src/conversation/index.ts"
import { configuredUniiLayer, durableMemoryLayer, Memory, sqliteStorageLayer } from "../src/memory/index.ts"
import { SummaryGeneration } from "../src/summary-generation/index.ts"
import { fakeRecognitionLayer } from "../src/speech-recognition/index.ts"
import { fakeSynthesisLayer } from "../src/speech-synthesis/index.ts"
import {
  Voice,
  VoiceTransport,
  voiceRoutes,
  fakeSpeechActivityLayer,
  VoiceLanguageConfiguration,
  defaultVoiceLanguageConfiguration,
  VoiceOutputConfiguration,
  defaultVoiceOutputSettings
} from "../src/voice/index.ts"
import { voiceAdmissionsFixture } from "./voice-admission-fixture.ts"
import { voiceTransportFixture } from "./voice-fixture.ts"
import { temporaryDatabase } from "./memory-fixture.ts"

// A composition root for the real services; only provider/resource delivery is controlled.
const joinLifetimeMillis = 120000
const attachmentMillis = 10
const httpBadRequest = 400
const httpNotFound = 404
const httpFailure = 500
const database = await temporaryDatabase()
try {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const summaries = yield* Deferred.make<void>()
        let answerCalls = 0
        let summaryCalls = 0
        const summary = Layer.succeed(SummaryGeneration, {
          summarize: () =>
            Effect.sync(() => {
              summaryCalls++
            }).pipe(Effect.andThen(Deferred.await(summaries)), Effect.as("Retained synthetic learning memory."))
        })
        const answer = Layer.effect(
          AnswerGeneration,
          Effect.gen(function* () {
            const real = yield* AnswerGeneration
            return AnswerGeneration.of({
              ...real,
              generate: (request) => {
                answerCalls++
                return real.generate(request)
              }
            })
          })
        ).pipe(Layer.provide(fakeAnswerLayer(0)))
        const resource = sqliteStorageLayer(database.path)
        const memory = configuredUniiLayer().pipe(
          Layer.provide(summary),
          Layer.provide(durableMemoryLayer.pipe(Layer.provide(resource)))
        )
        const conversation = Conversation.configuredLayer.pipe(
          Layer.provide(
            Layer.mergeAll(
              answer,
              memory,
              Layer.succeed(ReplyConfiguration, { ...defaultReplySettings, deltaMillis: 0, attachmentMillis })
            )
          ),
          Layer.provideMerge(resource)
        )
        const fixture = voiceTransportFixture()
        const transport = Layer.effect(
          VoiceTransport,
          Effect.gen(function* () {
            const real = yield* VoiceTransport
            return VoiceTransport.of({
              open: (...args) =>
                real.open(...args).pipe(
                  Effect.bindTo("opened"),
                  Effect.bind("now", () => Clock.currentTimeMillis),
                  Effect.map(({ now, opened }) => ({
                    ...opened,
                    join: { ...opened.join, expiresAt: now + joinLifetimeMillis },
                    connection: {
                      ...opened.connection,
                      openOutput: (...outputArgs) =>
                        opened.connection.openOutput(...outputArgs).pipe(
                          Effect.map((publisher) => ({
                            ...publisher,
                            // Playback drain remains pending until the actual interruption aborts its owner.
                            drain: () => Effect.never
                          }))
                        )
                    }
                  }))
                )
            })
          })
        ).pipe(Layer.provide(fixture.layer))
        const admissions = voiceAdmissionsFixture().pipe(Layer.provide(conversation))
        const voice = Voice.configuredLayer.pipe(
          Layer.provide(
            Layer.mergeAll(
              conversation,
              transport,
              admissions,
              fakeRecognitionLayer(),
              fakeSynthesisLayer(),
              fakeSpeechActivityLayer,
              Layer.succeed(VoiceLanguageConfiguration, defaultVoiceLanguageConfiguration),
              Layer.succeed(VoiceOutputConfiguration, defaultVoiceOutputSettings)
            )
          )
        )
        const application = Layer.mergeAll(conversation, voice, memory)
        const server = HttpRouter.serve(Layer.merge(voiceRoutes, conversationRoutes)).pipe(
          Layer.provide(application),
          Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))
        )
        yield* Effect.gen(function* () {
          const realMemory = yield* Memory
          const origin = yield* HttpServer.addressFormattedWith(Effect.succeed)
          const controls = createServer((request, response) => {
            const respond = (value: unknown) => {
              response.setHeader("content-type", "application/json")
              response.end(JSON.stringify(value))
            }
            if (request.method === "POST" && request.url === "/release-summaries") {
              Effect.runPromise(Deferred.succeed(summaries, undefined))
                .then(() => respond({ released: true }))
                .catch(() => {
                  response.statusCode = httpFailure
                  response.end()
                })
            } else if (request.method === "GET" && request.url?.startsWith("/facts?before=")) {
              const before = Number(new URL(request.url, "http://localhost").searchParams.get("before"))
              if (!Number.isSafeInteger(before) || before < 0) {
                response.statusCode = httpBadRequest
                response.end()
                return
              }
              Effect.runPromise(realMemory.snapshot(before))
                .then((snapshot) => respond({ answerCalls, summaryCalls, snapshot }))
                .catch(() => {
                  response.statusCode = httpFailure
                  response.end()
                })
            } else {
              response.statusCode = httpNotFound
              response.end()
            }
          })
          yield* Effect.acquireRelease(
            Effect.promise(() => new Promise<void>((resolve) => controls.listen(0, "127.0.0.1", resolve))),
            () => Effect.promise(() => new Promise<void>((resolve) => controls.close(() => resolve())))
          )
          const address = controls.address()
          if (address === null || typeof address === "string") throw new Error("Missing control address")
          process.stdout.write(JSON.stringify({ origin, controlOrigin: `http://127.0.0.1:${address.port}` }) + "\n")
          yield* Effect.callback<void>((resume) => {
            const stop = () => resume(Effect.void)
            process.once("SIGTERM", stop)
            process.once("SIGINT", stop)
            return Effect.sync(() => {
              process.removeListener("SIGTERM", stop)
              process.removeListener("SIGINT", stop)
            })
          })
        }).pipe(Effect.provide(Layer.mergeAll(server, application)))
      })
    )
  )
} finally {
  await database.close()
}
